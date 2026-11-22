import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentServerClient,
  BOT_TEMPLATES,
  BridgeState,
  COUNCIL_EXPERTS,
  DEFAULT_COUNCIL,
  buildCouncilDebatePrompt,
  buildCouncilDecisionPrompt,
  buildCouncilProposalPrompt,
  formatTally,
  parseCouncilArgs,
  parseVotes,
  tallyVotes,
  buildInsightsPrompt,
  buildSkillRequest,
  chunkText,
  describeSchedule,
  expandScheduledText,
  nextRun,
  parseScheduleArgs,
  summarizeEvents,
  validTimeZone,
  describeStep,
  explainError,
  formatElapsed,
  isAuthorized,
  loadConfig,
  buildCoordinatorPrompt,
  buildIntegrationPrompt,
  buildMemberPrompt,
  parseAssignments,
  parseMessage,
  parseNewArgs,
  parseWorkingDir,
  slugify,
  statusTransition,
  teamDone,
} from "../../scripts/telegram-bridge-lib.mjs";

describe("telegram bridge config", () => {
  it("requires a bot token", () => {
    expect(() => loadConfig({})).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("starts in setup mode with an empty allowlist, authorizing nobody", () => {
    const config = loadConfig({ TELEGRAM_BOT_TOKEN: "t" });

    expect(config.allowedChats.size).toBe(0);
    expect(isAuthorized(config, 123, 1)).toBe(false);
  });

  it("authorizes listed chats and, when set, only listed users", () => {
    const chatsOnly = loadConfig({
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_ALLOWED_CHAT_IDS: "-100, 42",
    });
    const withUsers = loadConfig({
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_ALLOWED_CHAT_IDS: "-100",
      TELEGRAM_ALLOWED_USER_IDS: "7",
    });

    expect(isAuthorized(chatsOnly, -100, 999)).toBe(true);
    expect(isAuthorized(chatsOnly, 5, 999)).toBe(false);
    expect(isAuthorized(withUsers, -100, 7)).toBe(true);
    expect(isAuthorized(withUsers, -100, 8)).toBe(false);
  });

  it("strips a trailing slash from the agent-server URL", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "t",
      OH_AGENT_SERVER_URL: "http://host:18000/",
    });

    expect(config.agentServerUrl).toBe("http://host:18000");
  });
});

describe("parseMessage", () => {
  it("parses commands, including group-style /cmd@Bot", () => {
    expect(parseMessage("/new@MyBot fix the tests")).toEqual({
      kind: "command",
      command: "new",
      args: "fix the tests",
    });
    expect(parseMessage("/agents")).toEqual({
      kind: "command",
      command: "agents",
      args: "",
    });
  });

  it("parses messages addressed to an agent", () => {
    expect(parseMessage("@Front: use tailwind")).toEqual({
      kind: "addressed",
      agent: "front",
      text: "use tailwind",
    });
  });

  it("treats everything else as plain text", () => {
    expect(parseMessage("  hola  ")).toEqual({ kind: "text", text: "hola" });
  });
});

describe("parseNewArgs", () => {
  it("extracts an optional @name before the task", () => {
    expect(parseNewArgs("@api add pagination")).toEqual({
      name: "api",
      task: "add pagination",
    });
    expect(parseNewArgs("add pagination")).toEqual({
      name: null,
      task: "add pagination",
    });
  });

  it("flags names Telegram users cannot address", () => {
    expect(parseNewArgs("@bad.name do it").invalidName).toBe("bad.name");
  });
});

describe("chunkText", () => {
  it("keeps short text whole and splits long text under the limit", () => {
    expect(chunkText("short")).toEqual(["short"]);

    const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkText(long, 500);

    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
    expect(chunks.join("\n")).toBe(long);
  });
});

describe("statusTransition", () => {
  it("reports completion only after the agent was working", () => {
    expect(statusTransition("running", "finished")).toBe("done");
    expect(statusTransition("pending", "idle")).toBe("done");
    expect(statusTransition("idle", "idle")).toBeNull();
    expect(statusTransition("finished", "idle")).toBeNull();
  });

  it("reports confirmation requests and problems", () => {
    expect(statusTransition("running", "waiting_for_confirmation")).toBe(
      "confirm",
    );
    expect(statusTransition("running", "error")).toBe("problem");
    expect(statusTransition("running", "stuck")).toBe("problem");
  });
});

describe("BridgeState", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("tracks agents per chat, names them uniquely and finds them by name, index or id", () => {
    const state = new BridgeState();

    const first = state.addAgent(1, { id: "aaaa1111", name: null });
    const second = state.addAgent(1, { id: "bbbb2222", name: "api" });
    const third = state.addAgent(1, { id: "cccc3333", name: "api" });

    expect([first, second, third]).toEqual(["agente1", "api", "api-2"]);
    expect(state.activeAgent(1)?.id).toBe("cccc3333");
    expect(state.findAgent(1, "@api")?.id).toBe("bbbb2222");
    expect(state.findAgent(1, "1")?.id).toBe("aaaa1111");
    expect(state.findAgent(1, "cccc")?.id).toBe("cccc3333");
    expect(state.findAgent(2, "api")).toBeNull();
  });

  it("routes replies to the agent that sent the message and falls back on removal", () => {
    const state = new BridgeState();
    state.addAgent(1, { id: "a", name: "one" });
    state.addAgent(1, { id: "b", name: "two" });
    state.rememberMessage(1, 50, "a");

    expect(state.agentForReply(1, 50)?.name).toBe("one");

    state.removeAgent(1, "b");
    expect(state.activeAgent(1)?.id).toBe("a");
  });

  it("persists and reloads", () => {
    dir = mkdtempSync(join(tmpdir(), "tg-bridge-"));
    const path = join(dir, "state.json");
    const state = new BridgeState();
    state.offset = 9;
    state.addAgent(-100, { id: "x", name: "w" });

    state.save(path);
    const loaded = BridgeState.load(path);

    expect(loaded.offset).toBe(9);
    expect(loaded.findAgent(-100, "w")?.id).toBe("x");
    expect(BridgeState.load(join(dir, "missing.json")).offset).toBe(0);
  });
});

describe("AgentServerClient", () => {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("starts a conversation from an Agent Profile with the session key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ id: "conv-1" }));
    const client = new AgentServerClient({
      baseUrl: "http://srv",
      sessionApiKey: "secret",
      fetchImpl,
    });

    const result = await client.createConversation({
      profileId: "p1",
      task: "do it",
      workingDir: "workspace/project",
      chatId: -100,
    });

    expect(result.id).toBe("conv-1");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://srv/api/conversations");
    expect(init.headers["X-Session-API-Key"]).toBe("secret");
    expect(JSON.parse(init.body)).toMatchObject({
      agent_profile_id: "p1",
      workspace: { working_dir: "workspace/project" },
      initial_message: {
        role: "user",
        content: [{ type: "text", text: "do it" }],
        run: true,
      },
      tags: { source: "telegram", telegramchat: "-100" },
    });
  });

  it("resolves profiles by name, falling back to the active profile", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      ok({
        active_agent_profile_id: "id-b",
        profiles: [
          { id: "id-a", name: "Claude Code" },
          { id: "id-b", name: "OpenHands" },
        ],
      }),
    );
    const client = new AgentServerClient({
      baseUrl: "http://srv",
      sessionApiKey: null,
      fetchImpl,
    });

    expect(await client.resolveProfileId("claude code")).toBe("id-a");
    expect(await client.resolveProfileId(null)).toBe("id-b");
    expect(await client.resolveProfileId("nope")).toBeNull();
  });

  it("surfaces HTTP errors with the status code", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("boom", { status: 500 }));
    const client = new AgentServerClient({
      baseUrl: "http://srv",
      sessionApiKey: null,
      fetchImpl,
    });

    await expect(client.getConversation("c")).rejects.toThrow(/HTTP 500/);
  });
});

describe("telegram bridge teams", () => {
  it("reads the plan block, not stray mentions in the prose", () => {
    const answer = [
      "I looked at the repo. @maria wrote the auth module last year.",
      "",
      "Plan:",
      "1. **@api**: add GET /health in src/server.ts, done when it returns 200",
      "- @web — show the health badge on the dashboard",
      "@api: duplicate name is ignored",
      "@Docs actualizar el README",
    ].join("\n");

    expect(parseAssignments(answer)).toEqual([
      {
        name: "api",
        task: "add GET /health in src/server.ts, done when it returns 200",
      },
      { name: "web", task: "show the health badge on the dashboard" },
      { name: "docs", task: "actualizar el README" },
    ]);
  });

  it("caps the number of assignments", () => {
    const lines = Array.from({ length: 9 }, (_, i) => `@a${i}: task ${i}`);

    expect(parseAssignments(lines.join("\n"), 3)).toHaveLength(3);
    expect(parseAssignments("no plan here")).toEqual([]);
  });

  it("tells a member its subtask, the goal and who leads", () => {
    const prompt = buildMemberPrompt({
      name: "api",
      lead: "lider",
      goal: "ship health checks",
      subtask: "add /health",
    });

    expect(prompt).toContain("You are @api");
    expect(prompt).toContain("led by @lider");
    expect(prompt).toContain("Team goal: ship health checks");
    expect(prompt).toContain("Your subtask: add /health");
    expect(prompt).toContain(
      "`safe-branch start ship-health-checks-api --worktree`",
    );
    expect(prompt).toContain("worktree on feat/ship-health-checks-api");
    expect(prompt).toContain("change-safety-guard");
    expect(prompt).toContain("Never commit to the default branch.");
  });

  it("builds short ascii branch slugs", () => {
    expect(slugify("Añade un formulario de contacto con validación")).toBe(
      "anade-formulario-contacto-con",
    );
    expect(slugify("!!!")).toBe("feature");
  });

  it("asks the lead for one integration PR, without merging to main", () => {
    const prompt = buildIntegrationPrompt(
      [{ name: "api", response: "branch feat/x-api, PR #4" }],
      "contact form",
    );

    expect(prompt).toContain("@api:\nbranch feat/x-api, PR #4");
    expect(prompt).toContain("feat/contact-form");
    expect(prompt).toContain("Do not\nmerge into the default branch");
  });

  it("waits until every member ran and settled, or failed", () => {
    const team = (members: object[]) =>
      teamDone(
        [
          { id: "lead", role: "lead" },
          ...members.map((m) => ({ team: "lead", ...m })),
        ],
        "lead",
      );

    expect(team([])).toBe(false);
    expect(team([{ lastStatus: "idle" }])).toBe(false); // never started
    expect(
      team([
        { lastStatus: "finished", seenRunning: true },
        { lastStatus: "running", seenRunning: true },
      ]),
    ).toBe(false);
    expect(
      team([
        { lastStatus: "finished", seenRunning: true },
        { lastStatus: "error" },
      ]),
    ).toBe(true);
  });

  it("accepts only absolute working dirs without ..", () => {
    expect(parseWorkingDir("/documents/dracma-web/")).toBe(
      "/documents/dracma-web",
    );
    expect(parseWorkingDir("documents")).toBeNull();
    expect(parseWorkingDir("/documents/../etc")).toBeNull();
  });
});

describe("explainError", () => {
  it("turns a missing login into the steps to fix it", () => {
    const text = explainError({
      code: "ACPAuthRequired",
      detail: "[-32000] Authentication required",
    });

    expect(text).toContain("docker exec -it agent-canvas claude");
    expect(text).toContain("/profile default");
  });

  it("shows other errors as code and detail", () => {
    expect(
      explainError({ code: "Timeout", detail: "LLM call timed out" }),
    ).toBe("Error: Timeout — LLM call timed out");
    expect(explainError(null)).toBe("");
  });
});

describe("BridgeState.switchBot", () => {
  it("resets per-bot offsets and reply map but keeps the agents", () => {
    const state = new BridgeState({
      botId: 111,
      offset: 200692714,
      messageMap: { "555:10": "conv-1" },
      chats: {
        "555": { agents: [{ id: "conv-1", name: "api" }], active: "conv-1" },
      },
    });

    expect(state.switchBot(111)).toBe(false);
    expect(state.offset).toBe(200692714);

    expect(state.switchBot(222)).toBe(true);
    expect(state.offset).toBe(0);
    expect(state.messageMap).toEqual({});
    expect(state.chats["555"].agents[0].name).toBe("api");
    expect(state.toJSON().botId).toBe(222);
  });

  it("resets a state saved before bot tracking, but not a fresh one", () => {
    const legacy = new BridgeState({ offset: 42, messageMap: { "1:2": "c" } });
    expect(legacy.switchBot(111)).toBe(true);
    expect(legacy.offset).toBe(0);

    const fresh = new BridgeState();
    expect(fresh.switchBot(111)).toBe(false);
    expect(fresh.botId).toBe(111);
  });
});

describe("progress notices", () => {
  it("names the kind of step without any command text", () => {
    expect(
      describeStep({
        kind: "ACPToolCallEvent",
        tool_kind: "execute",
        title: "K=$(cat ~/.openhands/agent-canvas/api-key.txt); curl …",
      }),
    ).toBe("ejecutando un comando");
    expect(
      describeStep({ kind: "ActionEvent", tool_name: "file_editor" }),
    ).toBe("editando archivos");
    expect(describeStep(null)).toBe("");
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(20_000)).toBe("1 min");
    expect(formatElapsed(7 * 60_000)).toBe("7 min");
    expect(formatElapsed(65 * 60_000)).toBe("1 h 5 min");
  });

  it("defaults to a notice every 3 minutes and allows turning it off", () => {
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: "t" }).progressMs).toBe(180_000);
    expect(
      loadConfig({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_PROGRESS_MINUTES: "0" })
        .progressMs,
    ).toBe(0);
  });
});

describe("automatic mode prompts", () => {
  it("lets the coordinator answer directly or plan with @name lines", () => {
    const prompt = buildCoordinatorPrompt("añade un formulario", {
      workingDir: "/documents/dracma-web",
    });

    expect(prompt).toContain("Working folder: /documents/dracma-web");
    expect(prompt).toContain("Do not write any @name lines");
    expect(prompt).toContain("@short-name:");
    expect(prompt).toContain("change-safety-guard");
    expect(prompt).toContain("User request: añade un formulario");
  });

  it("invites follow-up assignments only when allowed", () => {
    const results = [{ name: "api", response: "done" }];

    expect(
      buildIntegrationPrompt(results, "form", { followUp: true }),
    ).toContain("assign it with @name: task lines");
    expect(buildIntegrationPrompt(results, "form")).not.toContain(
      "assign it with @name",
    );
  });
});

describe("skill commands", () => {
  it("builds a scan request for known types and aliases", () => {
    const built = buildSkillRequest("scan", "db src/api");
    expect(built.request).toMatch(/code-scans/);
    expect(built.request).toMatch(/"database" scan/);
    expect(built.request).toMatch(/src\/api/);
    expect(built.request).toMatch(/do not change any code/);
  });

  it("shows usage for unknown scan types and missing args", () => {
    expect(buildSkillRequest("scan", "").usage).toMatch(/Tipos:/);
    expect(buildSkillRequest("scan", "nope").usage).toMatch(/Uso/);
    expect(buildSkillRequest("scan", "custom").usage).toMatch(/custom/);
    expect(buildSkillRequest("review", "").usage).toMatch(/PR/);
    expect(buildSkillRequest("ask", " ").usage).toMatch(/pregunta/);
  });

  it("routes security scans through security-audit", () => {
    expect(buildSkillRequest("scan", "seguridad").request).toMatch(
      /security-audit/,
    );
  });

  it("names the skill for every command", () => {
    expect(buildSkillRequest("review", "42").request).toMatch(/pr-reviewer/);
    expect(buildSkillRequest("review", "42").request).toMatch(
      /Do not post to GitHub/,
    );
    expect(buildSkillRequest("wiki", "").request).toMatch(/repo-wiki/);
    expect(buildSkillRequest("ask", "where is auth?").request).toMatch(
      /codebase-qa.*read-only/,
    );
    expect(buildSkillRequest("plan", "add login").request).toMatch(/plan mode/);
    expect(buildSkillRequest("latency", "").request).toMatch(
      /latency-optimizer/,
    );
    expect(buildSkillRequest("migrate", "JS a TS").request).toMatch(
      /migration-modernization.*wait for my approval/,
    );
    expect(buildSkillRequest("unknown", "x")).toBeNull();
  });
});

describe("schedules", () => {
  it("parses daily, weekday, weekly and interval specs", () => {
    expect(parseScheduleArgs("diario 09:00 /latency")).toEqual({
      schedule: {
        kind: "weekly",
        days: [0, 1, 2, 3, 4, 5, 6],
        hour: 9,
        minute: 0,
      },
      text: "/latency",
    });
    expect(parseScheduleArgs("laborables 8:30 run qa").schedule.days).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(parseScheduleArgs("Miércoles 18 haz algo").schedule).toEqual({
      kind: "weekly",
      days: [3],
      hour: 18,
      minute: 0,
    });
    expect(parseScheduleArgs("every 2h check").schedule).toEqual({
      kind: "interval",
      everyMs: 7_200_000,
    });
  });

  it("rejects bad specs", () => {
    expect(parseScheduleArgs("cada 5m x").error).toMatch(/15 min/);
    expect(parseScheduleArgs("lunes 25:00 x").error).toMatch(/Hora/);
    expect(parseScheduleArgs("pronto x").error).toMatch(/Cuándo/);
    expect(parseScheduleArgs("diario 09:00").error).toMatch(/Falta/);
  });

  it("computes the next run in the schedule's time zone", () => {
    // Friday 2026-11-20 12:00 UTC.
    const from = Date.UTC(2026, 10, 20, 12, 0);
    const monday9 = { kind: "weekly", days: [1], hour: 9, minute: 0 };
    expect(new Date(nextRun(monday9, from, "UTC")).toISOString()).toBe(
      "2026-11-23T09:00:00.000Z",
    );
    // 09:00 in Madrid (UTC+1 in November) is 08:00 UTC.
    expect(
      new Date(nextRun(monday9, from, "Europe/Madrid")).toISOString(),
    ).toBe("2026-11-23T08:00:00.000Z");
    const daily = {
      kind: "weekly",
      days: [0, 1, 2, 3, 4, 5, 6],
      hour: 12,
      minute: 0,
    };
    expect(nextRun(daily, from, "UTC")).toBe(from + 86_400_000);
    expect(nextRun({ kind: "interval", everyMs: 3_600_000 }, from)).toBe(
      from + 3_600_000,
    );
  });

  it("describes schedules and falls back to UTC for bad zones", () => {
    expect(describeSchedule(parseScheduleArgs("lunes 9:05 x").schedule)).toBe(
      "lunes 09:05",
    );
    expect(describeSchedule(parseScheduleArgs("cada 90m x").schedule)).toBe(
      "cada 90 min",
    );
    expect(describeSchedule(parseScheduleArgs("weekdays 7 x").schedule)).toBe(
      "laborables 07:00",
    );
    expect(validTimeZone("Not/AZone")).toBe("UTC");
    expect(validTimeZone("America/Bogota")).toBe("America/Bogota");
  });

  it("bot templates have valid schedules and expand skill commands", () => {
    for (const bot of Object.values(BOT_TEMPLATES)) {
      const parsed = parseScheduleArgs(`${bot.when} ${bot.text}`);
      expect(parsed.error).toBeUndefined();
      expect(expandScheduledText(parsed.text).length).toBeGreaterThan(20);
    }
    expect(expandScheduledText("/latency")).toMatch(/latency-optimizer/);
    expect(expandScheduledText("plain text")).toBe("plain text");
  });

  it("loads the time zone from config", () => {
    expect(
      loadConfig({
        TELEGRAM_BOT_TOKEN: "x",
        TELEGRAM_TIMEZONE: "Europe/Madrid",
      }).timeZone,
    ).toBe("Europe/Madrid");
    expect(loadConfig({ TELEGRAM_BOT_TOKEN: "x" }).timeZone).toBe("UTC");
  });
});

describe("session insights", () => {
  const events = [
    {
      kind: "MessageEvent",
      source: "user",
      timestamp: "2026-11-21T10:00:00Z",
      llm_message: { content: [{ text: "fix the login" }] },
    },
    {
      kind: "ActionEvent",
      source: "agent",
      timestamp: "2026-11-21T10:00:30Z",
      tool_name: "terminal",
      action: { kind: "ExecuteBashAction", command: "npm test" },
    },
    {
      kind: "ConversationErrorEvent",
      timestamp: "2026-11-21T10:02:00Z",
      code: "Timeout",
      detail: "tool timed out",
    },
  ];

  it("summarizes events with stats and elapsed times", () => {
    const { digest, stats } = summarizeEvents(events);
    expect(stats).toMatchObject({
      events: 3,
      steps: 1,
      errors: 1,
      userMessages: 1,
      durationSec: 120,
    });
    expect(digest).toMatch(/\+0s MessageEvent\[user\].*fix the login/);
    expect(digest).toMatch(/\+30s ActionEvent\[agent\] terminal.*\$ npm test/);
    expect(digest).toMatch(/code=Timeout/);
  });

  it("counts but doesn't list state updates", () => {
    const { digest, stats } = summarizeEvents([
      ...events,
      {
        kind: "ConversationStateUpdateEvent",
        timestamp: "2026-11-21T10:03:00Z",
      },
    ]);
    expect(stats.kinds.ConversationStateUpdateEvent).toBe(1);
    expect(digest).not.toMatch(/ConversationStateUpdateEvent/);
  });

  it("keeps head and tail when the digest is too long", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      kind: "ActionEvent",
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      action: { command: `step ${i} ${"x".repeat(100)}` },
    }));
    const { digest } = summarizeEvents(many, { maxChars: 5_000 });
    expect(digest.length).toBeLessThan(6_000);
    expect(digest).toMatch(/step 0 /);
    expect(digest).toMatch(/step 499 /);
    expect(digest).toMatch(/events omitted/);
  });

  it("handles empty input and builds the prompt", () => {
    expect(summarizeEvents([]).stats.events).toBe(0);
    const prompt = buildInsightsPrompt({
      name: "front",
      conversationId: "abc",
      stats: { events: 3 },
      digest: "line",
    });
    expect(prompt).toMatch(/session-insights skill/);
    expect(prompt).toMatch(/do not call the agent server API/);
  });

  it("lists events oldest first with paging", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [], next_page_id: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = new AgentServerClient({
      baseUrl: "http://x",
      sessionApiKey: "k",
      fetchImpl,
    });
    await client.listEvents("c1", { pageId: "p2" });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "http://x/api/conversations/c1/events/search?limit=100&sort_order=TIMESTAMP&page_id=p2",
    );
  });
});

describe("expert council", () => {
  it("uses the default panel, or the experts named before the colon", () => {
    expect(parseCouncilArgs("mejorar el onboarding")).toEqual({
      experts: DEFAULT_COUNCIL,
      topic: "mejorar el onboarding",
    });
    expect(
      parseCouncilArgs("ux, growth, marketing, perf: por qué no convierte"),
    ).toEqual({
      experts: ["ux", "growth", "rendimiento"],
      topic: "por qué no convierte",
    });
    // An unknown word means the colon belongs to the topic.
    expect(parseCouncilArgs("objetivo: subir la retención").experts).toEqual(
      DEFAULT_COUNCIL,
    );
    expect(parseCouncilArgs("").usage).toMatch(/Uso: \/consejo/);
    expect(parseCouncilArgs("ux: algo").usage).toMatch(/al menos 2/);
  });

  it("every expert and the default panel exist", () => {
    for (const key of DEFAULT_COUNCIL)
      expect(COUNCIL_EXPERTS[key]).toBeTruthy();
    const prompt = buildCouncilProposalPrompt({
      expert: "ux",
      name: "ux-2",
      topic: "checkout",
      panel: ["ux", "qa"],
    });
    expect(prompt).toContain("You are @ux-2, the UX/UI designer");
    expect(prompt).toContain("`ux-2-P1: title`");
    expect(prompt).toMatch(/READ-ONLY/);
  });

  it("debate shows only the other experts and asks for votes", () => {
    const prompt = buildCouncilDebatePrompt({
      expert: "ux",
      topic: "checkout",
      positions: [
        { name: "ux", text: "MINE" },
        { name: "qa", text: "QA VIEW" },
      ],
    });
    expect(prompt).toContain("@qa");
    expect(prompt).toContain("QA VIEW");
    expect(prompt).not.toContain("MINE");
    expect(prompt).toContain("VOTOS:");
  });

  it("reads the last votes line and counts Borda points", () => {
    expect(
      parseVotes(
        "blah\nVOTOS: ux-P1, qa-P2\n**Votos:** qa-p2, ux-2-P3, x-P1, y-P1",
      ),
    ).toEqual(["qa-p2", "ux-2-p3", "x-p1"]);
    expect(parseVotes("sin votos")).toEqual([]);
    const tally = tallyVotes([
      { name: "ux", text: "VOTOS: qa-P1, ux-P1, sec-P2" },
      { name: "qa", text: "VOTOS: ux-P1, qa-P1" },
      { name: "sec", text: "nada" },
    ]);
    expect(tally.map(({ id, points }) => [id, points])).toEqual([
      ["qa-p1", 5],
      ["ux-p1", 5],
      ["sec-p2", 1],
    ]);
    expect(formatTally(tally)).toContain("qa-p1 — 5 pts (@ux, @qa)");
    expect(formatTally([])).toBe("(nadie votó)");
  });

  it("the moderator weighs evidence and ends with a plan", () => {
    const prompt = buildCouncilDecisionPrompt({
      topic: "checkout",
      proposals: [{ name: "ux", text: "P" }],
      debate: [{ name: "ux", text: "D" }],
      tally: [{ id: "ux-p1", points: 3, voters: ["ux"] }],
    });
    expect(prompt).toMatch(/evidence over vote counts/);
    expect(prompt).toContain("qdrant-store");
    expect(prompt).toContain("@short-name:");
  });

  it("ships a weekly council bot", () => {
    expect(BOT_TEMPLATES.consejo.text).toMatch(/^\/consejo /);
    expect(
      parseScheduleArgs(
        `${BOT_TEMPLATES.consejo.when} ${BOT_TEMPLATES.consejo.text}`,
      ).text,
    ).toBe(BOT_TEMPLATES.consejo.text);
  });
});

describe("design command", () => {
  it("routes frontend work through the pencil-design skill", () => {
    expect(buildSkillRequest("design", "").usage).toMatch(/Uso: \/design/);
    const { request } = buildSkillRequest("design", "la pantalla Checkout");
    expect(request).toContain("pencil-design");
    expect(request).toContain("la pantalla Checkout");
    expect(COUNCIL_EXPERTS.frontend.skills.join(" ")).toContain(
      "pencil-design",
    );
  });
});

#!/usr/bin/env node
/**
 * Telegram bridge for OpenHands agents.
 *
 * Coordinate several agent conversations from a Telegram chat instead of
 * Slack: start agents, talk to one by name, broadcast to all, approve risky
 * actions, and get each agent's result posted back when it finishes.
 *
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_ALLOWED_CHAT_IDS=... npm run telegram-bridge
 *
 * See docs/TELEGRAM.md for setup and the full command list.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  QualityStore,
  alwaysOnTargets,
  buildCaseRunPrompt,
  buildCuratorPrompt,
  buildFeedbackPrompt,
  buildJudgePrompt,
  buildQualityNote,
  casePassed,
  checkCase,
  feedbackStats,
  formatScoreboard,
  installAlwaysOn,
  installLearnedSkills,
  lintSkillsDir,
  parseEvalLines,
  parseProposals,
  prepareCase,
  pruneRuns,
  readCases,
  reviewAnswer,
  uninstallSkill,
  validateProposal,
} from "./agent-quality-lib.mjs";
import {
  MEMORY_LEVELS,
  QdrantRest,
  buildChunkNotes,
  buildLessonNote,
  findRepoRoot,
  ingestSource,
  ingestible,
  memoryFilter,
  memoryWhere,
  readSourceFile,
  runGraphify,
  storeNotes,
} from "./knowledge-lib.mjs";
import { McpStdioClient } from "./memory-watcher-lib.mjs";
import { buildMemoryMcpServer } from "./register-memory-mcp.mjs";

import {
  AgentServerClient,
  BOT_TEMPLATES,
  BridgeState,
  buildGreeting,
  findInlineCommand,
  smallTalk,
  CHAT_MCP_KEY,
  appendChatLog,
  formatChatLog,
  handleMcpMessage,
  allowRelay,
  buildAgentNetworkNote,
  buildRelayPrompt,
  parseAgentMessages,
  buildProjectContext,
  parseProjectArgs,
  scopeOf,
  splitScope,
  McpHttpClient,
  PEN_LIST_SNIPPET,
  parsePenAppState,
  parsePenNodeList,
  penExportSnippet,
  pickPenNodes,
  buildPenEditPrompt,
  buildPenUxPrompt,
  parsePenRequest,
  parsePhotoIds,
  penMessage,
  toPenHostPath,
  COUNCIL_EXPERTS,
  buildCouncilDebatePrompt,
  buildCouncilDecisionPrompt,
  buildCouncilProposalPrompt,
  formatTally,
  parseCouncilArgs,
  tallyVotes,
  SKILL_COMMANDS,
  TelegramClient,
  buildInsightsPrompt,
  buildSkillRequest,
  describeSchedule,
  expandScheduledText,
  formatWhen,
  nextRun,
  parseScheduleArgs,
  summarizeEvents,
  buildChatContext,
  buildCoordinatorPrompt,
  buildShipPrompt,
  queuedAck,
  shipIntent,
  shouldAnswer,
  buildIntegrationPrompt,
  buildLeadPrompt,
  buildMemberPrompt,
  describeStep,
  explainError,
  formatElapsed,
  isAuthorized,
  loadConfig,
  MAX_AUTO_ROUNDS,
  parseAssignments,
  parseMessage,
  parseNewArgs,
  parseWorkingDir,
  statusTransition,
  teamDone,
} from "./telegram-bridge-lib.mjs";

const HELP = `Puente OpenHands ↔ Telegram

Modo automático (activado): escribe lo que necesitas en lenguaje normal.
@coordinador responde o planifica, el bot crea los subagentes solo, y al
terminar @coordinador integra los resultados y te da el resumen.
/auto off — vuelve al modo manual (el texto va al agente activo)
En grupos respondo cuando me hablan (bot, equipo, @coordinador, @agente, una
respuesta a mi mensaje); la charla entre personas la leo como contexto.

/ship [notas] — o «shipéalo», «abre el PR»: el agente que hizo el trabajo lo
  lleva a un PR revisado con la CI en verde (rama, commits, push, PR, revisión,
  CI). Nunca fusiona: eso lo decides tú.

/new <tarea> — crea un agente nuevo con esa tarea
/new @nombre <tarea> — igual, con nombre propio
/team [@nombre] <tarea> — un agente líder planifica y reparte subtareas
/dispatch — reparte tareas a mano, una por línea: @nombre tarea
/dir [ruta] — carpeta de trabajo de los próximos agentes (p. ej. /documents/mi-proyecto)
Proyectos (cada chat o tema de un grupo con temas = un proyecto aparte):
/project — proyecto actual y lista · /project new <nombre> [carpeta] · /project use <nombre> · /project rm <nombre>
/agents — lista los agentes de este chat
/use <nombre|n> — elige el agente activo
@nombre <mensaje> — habla con un agente concreto
Los agentes también se hablan entre sí aquí: una línea "PARA @nombre: …" en su respuesta llega al otro agente y se publica en el chat (💬 @a → @b). Puedes responder tú por ellos
(texto normal) — va al agente activo
(responder a un mensaje de un agente) — va a ese agente
/all <mensaje> — envía el mensaje a todos los agentes
/status [nombre] — estado de un agente
/result [nombre] — última respuesta del agente
/stop [nombre] — pausa un agente
/forget <nombre> — deja de seguir un agente en este chat
Agentes expertos (los reparte @coordinador):
/scan <tipo> [enfoque] — escaneo: performance, database, coverage, dead-code, quality, security, dependencies…
/review <PR> — revisión del PR: bugs, flags y seguridad
/wiki [notas] — genera o actualiza la wiki del repo con diagramas
/ask <pregunta> — responde sobre el código con citas (no cambia nada)
/plan <objetivo> — plan paso a paso y prompt listo para ejecutar
/latency [enfoque] — arregla lo más lento y abre un PR con el antes/después
/security [enfoque] — auditoría de seguridad (solo lectura)
/migrate <de → a> — migración por pasos (p. ej. JavaScript a TypeScript)
/insights [nombre] — análisis de la sesión de un agente y lecciones a memoria
/ux [pantalla] — @ux revisa la UX del diseño en pen.dev, prioriza los problemas y crea una copia optimizada (antes/después). También: "pen, revisa la ux de wallet"
/pen <lo que quieras> — habla con pen.dev en lenguaje natural: "foto de la pantalla wallet únicamente", "lista", "arregla el header de wallet" (te manda la foto al terminar). También vale escribir "pen, …" o "en pen …" sin comando
/design <tarea> — frontend con pen.dev: diseño .pen → código (o código → diseño) vía Pencil MCP

Consejo de expertos (trabajan en paralelo, debaten y votan):
/consejo [expertos:] <tema> — cada experto propone por su cuenta, luego
  debaten las propuestas de los demás y votan; @moderador decide, guarda la
  decisión en memoria y te propone el plan para repartir (tú lo apruebas)
  Ej.: /consejo ux, growth, producto: por qué no convierte la landing
/consejo — expertos disponibles y consejos en curso

Calidad y aprendizaje (feedback loop):
👍/👎 bajo cada resultado — tu valoración; con 👎 te pregunto qué falló y se lo paso al agente para que lo corrija
/feedback — valoraciones por agente · /feedback @agente <nota> — deja una nota
/evals — @juez puntúa el trabajo reciente (tarea, verificación, calidad, seguridad, comunicación)
/evals casos [id…] — corre los casos de evaluación en carpetas de prueba y compara con la última vez
/evals skills — revisa que las skills estén bien escritas · /evals historial
/mejora [enfoque] — @curador convierte el feedback y los evals en nuevas skills, reglas (guardrails) o casos; tú apruebas cada una
/mejora lista — lo aprendido · /mejora quitar regla <n> | skill <nombre> | eval <id>
Memoria del equipo (Qdrant + grafo graphify, siempre conectada a todos los agentes):
/memoria — qué sabe este tema · /memoria buscar [tema|carpeta|workspace|todo] <q> · /memoria aprende <lección>
/ingest <ruta | carpeta | URL> — ingiere datos en la memoria (y actualiza el grafo del repo)
(manda un archivo al chat) — lo guardo en la memoria; si pones un texto, se lo paso a @coordinador
/mejora auto on|off — automejora: aplica sola las reglas y casos validados (las skills siempre las apruebas tú)
Cada respuesta pasa un control: oculta secretos, avisa de comandos de riesgo y de cambios de código sin VERIFICACIÓN.

Bots y tareas programadas:
/bots — plantillas de bots siempre activos (latency, qa, scans, security, deps, consejo, wiki)
/bot <plantilla> [cuándo] — activa un bot en este chat y carpeta
/schedule <cuándo> <texto o /comando> — programa una tarea (diario 09:00, lunes 09:00, laborables 08:30, cada 6h)
/schedule — lista las tareas · /schedule rm <id> · /schedule run <id>

/profiles — perfiles de agente del servidor
/profile <nombre> — perfil para los próximos /new de este chat
/whoami — muestra el id de este chat`;

const COMMANDS = [
  ["ship", "Llevar el trabajo a un PR revisado con CI verde"],
  ["auto", "Modo automático on/off"],
  ["new", "Crear un agente con una tarea"],
  ["team", "Líder que planifica y reparte subtareas"],
  ["dispatch", "Repartir tareas: @nombre tarea por línea"],
  ["dir", "Carpeta de trabajo de los próximos agentes"],
  ["project", "Proyectos: un chat o tema por proyecto"],
  ["agents", "Listar agentes del chat"],
  ["use", "Elegir agente activo"],
  ["all", "Mensaje a todos los agentes"],
  ["status", "Estado de un agente"],
  ["result", "Última respuesta de un agente"],
  ["stop", "Pausar un agente"],
  ["scan", "Escanear el repo por un tipo de problema"],
  ["review", "Revisar un PR"],
  ["wiki", "Generar la wiki del repo"],
  ["ask", "Preguntar sobre el código"],
  ["plan", "Planificar un cambio"],
  ["latency", "Optimizar lo más lento"],
  ["security", "Auditoría de seguridad"],
  ["migrate", "Migración por pasos"],
  ["insights", "Analizar la sesión de un agente"],
  ["pen", "Hablar con pen.dev: fotos, cambios"],
  ["ux", "Revisión y optimización UX del diseño"],
  ["design", "Frontend con diseños de pen.dev"],
  ["consejo", "Consejo de expertos: proponen, debaten y deciden"],
  ["feedback", "Valoraciones de los agentes"],
  ["evals", "Evaluar a los agentes (@juez)"],
  ["mejora", "Aprender del feedback: skills, reglas y evals"],
  ["ingest", "Ingerir datos en la memoria (ruta o URL)"],
  ["memoria", "Memoria del equipo: estado y búsqueda"],
  ["bots", "Plantillas de bots"],
  ["bot", "Activar un bot programado"],
  ["schedule", "Tareas programadas"],
  ["profiles", "Perfiles de agente"],
  ["help", "Ayuda"],
].map(([command, description]) => ({ command, description }));

const KNOWN_COMMANDS = new Set([
  ...COMMANDS.map(({ command }) => command),
  "consejo",
  "council",
  "debate",
  "proyecto",
  "projects",
  "proyectos",
  "foto",
  "screen",
  "eval",
  "ingesta",
  "ingerir",
  "memory",
  "mejoras",
  "aprende",
  "improve",
  "schedules",
  "whoami",
  "shipit",
]);

/** Set at startup (getMe): used to tell replies and @mentions to the bot. */
let botIdentity = null;

const config = loadConfig();
const state = BridgeState.load(config.statePath);
const server = new AgentServerClient({
  baseUrl: config.agentServerUrl,
  sessionApiKey: config.sessionApiKey,
});
const telegram = new TelegramClient({
  token: config.token,
  apiBase: config.telegramApiBase,
});

const save = () => state.save(config.statePath);
const log = (...args) => console.log(new Date().toISOString(), ...args);

// Feedback loop (docs/FEEDBACK-LOOP.md): learned mechanisms live next to the
// bridge state; built-in skills and eval cases ship with the bridge.
const HERE = dirname(fileURLToPath(import.meta.url));
const firstDir = (...dirs) =>
  dirs.find((dir) => dir && existsSync(dir)) ?? null;
const quality = new QualityStore(
  process.env.AGENT_LEARNING_DIR?.trim() ||
    join(dirname(resolve(config.statePath)), "agent-learning"),
);
const BUILTIN_CASES_DIR = firstDir(
  process.env.AGENT_EVALS_DIR?.trim(),
  join(HERE, "evals/cases"),
  join(HERE, "../evals/cases"),
);
const BUILTIN_SKILLS_DIR = firstDir(
  join(HERE, "skills"),
  join(HERE, "../skills"),
);
const SKILL_TARGETS = [
  join(homedir(), ".agents/skills"),
  join(
    process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"),
    "skills",
  ),
];
/**
 * The protocol + learned rules in every agent's permanent context, OpenHands
 * UI agents included (installAlwaysOn). Rewritten when the rules change.
 */
let alwaysOnReady = false;
function syncAlwaysOn() {
  const written = installAlwaysOn(
    quality.guardrails(),
    alwaysOnTargets(process.env, homedir()),
  );
  alwaysOnReady = written.some((path) => path.endsWith(".md"));
  return written;
}
/** Where a chat's memory lives: its topic, workspace and folder. */
const whereOf = (chatId) =>
  memoryWhere({ scope: chatId, folder: workingDirFor(state.chat(chatId)) });
const builtinSkills = () =>
  BUILTIN_SKILLS_DIR
    ? readdirSync(BUILTIN_SKILLS_DIR).filter((name) =>
        existsSync(join(BUILTIN_SKILLS_DIR, name, "SKILL.md")),
      )
    : [];
const allCases = () => {
  const learned = quality.learnedCases();
  const builtin = readCases(BUILTIN_CASES_DIR).filter(
    (item) => !learned.some((other) => other.id === item.id),
  );
  return [...builtin, ...learned];
};

async function say(chatId, text, extra = {}, agent = null) {
  const sent = await telegram.sendText(chatId, text, extra);
  appendChatLog(state.chat(chatId), "bot", text);
  if (agent) {
    for (const message of sent)
      state.rememberMessage(chatId, message.message_id, agent.id);
    save();
  }
  return sent;
}

/**
 * An agent just got new work. Until it is seen running again, a settled
 * status is the previous turn's: a new turn can report idle before it starts.
 */
function markPending(agent) {
  agent.lastStatus = "pending";
  agent.seenRunning = false;
  delete agent.runningSince;
  delete agent.lastProgressAt;
}

/** "Started" once per turn, then a "still working" note every progressMs. */
async function reportProgress(chatId, agent) {
  const now = Date.now();
  if (!agent.runningSince) {
    agent.runningSince = now;
    agent.lastProgressAt = now;
    // The coordinator just shows "typing…"; subagents announce themselves.
    if (!agent.coordinator)
      await say(chatId, `▶️ @${agent.name} está trabajando…`, {}, agent);
    return;
  }
  if (agent.coordinator)
    telegram.sendChatAction(chatId, "typing").catch(() => {});
  if (!config.progressMs || now - agent.lastProgressAt < config.progressMs)
    return;
  agent.lastProgressAt = now;
  const step = describeStep(await server.lastStep(agent.id).catch(() => null));
  await say(
    chatId,
    `⏳ @${agent.name} sigue trabajando (${formatElapsed(now - agent.runningSince)})${step ? `, ahora ${step}` : ""}.`,
    {},
    agent,
  );
}

function resolveTarget(chatId, ref) {
  return ref ? state.findAgent(chatId, ref) : state.activeAgent(chatId);
}

async function sendToAgent(chatId, agent, text, replyTo) {
  await server.sendMessage(agent.id, text);
  agent.lastAsk = String(text).slice(0, 600);
  markPending(agent);
  save();
  await say(chatId, `➡️ Enviado a @${agent.name}`, { replyTo });
}

function workingDirFor(chat) {
  return chat.workingDir ?? config.workingDir;
}

const isAuto = (chat) => chat.auto !== false;

/** The chat's persistent coordinator (automatic mode), or null. */
function coordinatorOf(chat) {
  return chat.agents.find((agent) => agent.coordinator) ?? null;
}

/** Automatic mode: a plain request goes to the coordinator, created on demand. */
async function routeToCoordinator(
  chatId,
  text,
  messageId,
  { workingDir = null, label = null } = {},
) {
  const chat = state.chat(chatId);
  const dir = workingDir ?? workingDirFor(chat);
  let lead = coordinatorOf(chat);
  const busy = ["running", "pending"].includes(lead?.lastStatus);
  const context = buildChatContext(chat.log ?? [], lead?.contextAt ?? 0, {
    skipLast: !label,
  });
  const prompt = `${context}${buildCoordinatorPrompt(text, { workingDir: dir })}`;
  if (!lead) {
    lead = await createAgent(chatId, {
      name: "coordinador",
      task: prompt,
      extra: { role: "lead", coordinator: true },
    });
  } else {
    await server.sendMessage(lead.id, prompt);
    markPending(lead);
  }
  Object.assign(lead, {
    goal: text,
    workingDir: dir,
    awaitingPlan: true,
    rounds: 0,
    teamNotified: false,
    contextAt: Date.now(),
  });
  chat.active = lead.id;
  save();
  // An idle coordinator just answers (the chat shows "typing…"); a note only
  // when the request waits behind other work or comes from a schedule.
  if (label)
    return say(
      chatId,
      `🧭 ${label} → @${lead.name} en ${dir}. Te iré avisando.`,
      {},
      lead,
    );
  if (busy)
    return say(
      chatId,
      queuedAck(lead.name, text),
      messageId ? { replyTo: messageId } : {},
      lead,
    );
  telegram.sendChatAction(chatId, "typing").catch(() => {});
  return [];
}

/**
 * /ship or «shipéalo»: the agent that did the work takes it to a reviewed
 * PR with green CI. A reply picks that agent; otherwise the latest one that
 * reported work here; otherwise the coordinator.
 */
async function shipCommand(chatId, extra, messageId, message = null) {
  const chat = state.chat(chatId);
  const replied = message?.reply_to_message
    ? state.agentForReply(chatId, message.reply_to_message.message_id)
    : null;
  const helpers = /^(juez|curador|eval-)/;
  const lastWorker = [...(chat.recentWork ?? [])]
    .reverse()
    .map((item) => chat.agents.find((agent) => agent.id === item.agentId))
    .find((agent) => agent && !helpers.test(agent.name));
  const target = replied ?? lastWorker ?? coordinatorOf(chat);
  const prompt = buildShipPrompt(String(extra ?? "").trim(), {
    workingDir: target?.workingDir ?? workingDirFor(chat),
  });
  if (!target) {
    await routeToCoordinator(chatId, prompt, messageId);
    return say(
      chatId,
      "🚢 Ship en marcha con @coordinador: rama, commits, PR, revisión y CI. Te aviso con el enlace del PR.",
    );
  }
  await server.sendMessage(target.id, prompt);
  target.lastAsk = `ship ${String(extra ?? "")}`.trim();
  target.shipping = true;
  markPending(target);
  save();
  return say(
    chatId,
    `🚢 @${target.name} lleva su trabajo a un PR: rama, commits, push, revisión y CI hasta verde. Te paso el enlace; fusionar lo decides tú.`,
    messageId ? { replyTo: messageId } : {},
    target,
  );
}

/** Send the team's results to its lead; in automatic mode it may follow up. */
async function integrate(chatId, lead) {
  const chat = state.chat(chatId);
  const members = chat.agents.filter((item) => item.team === lead.id);
  const results = [];
  for (const member of members) {
    results.push({
      name: member.name,
      response: await server.finalResponse(member.id).catch(() => ""),
    });
  }
  const followUp =
    isAuto(chat) && lead.coordinator && (lead.rounds ?? 0) < MAX_AUTO_ROUNDS;
  await server.sendMessage(
    lead.id,
    buildIntegrationPrompt(results, lead.goal, { followUp }),
  );
  markPending(lead);
  lead.awaitingPlan = followUp;
  save();
  return say(chatId, `🧩 @${lead.name} está integrando los resultados.`);
}

/** Creates a conversation and tracks it in the chat; returns the agent. */
async function createAgent(
  chatId,
  { name, task, extra = {}, workingDir = null },
) {
  const chat = state.chat(chatId);
  const profileId = await server.resolveProfileId(
    chat.profile ?? config.defaultProfile,
  );
  if (!profileId) {
    throw new Error(
      "No hay perfil de agente. Crea uno en Agent Canvas (Ajustes → Agente) o usa /profiles.",
    );
  }
  const dir = workingDir ?? workingDirFor(chat);
  const finalName = state.uniqueName(
    chatId,
    name ?? `agente${chat.agents.length + 1}`,
  );
  const others = chat.agents.map((item) => item.name);
  const conversation = await server.createConversation({
    profileId,
    task: `${buildProjectContext(chat.project, dir)}${buildAgentNetworkNote(finalName, others, config.chatMcpPort ? String(chatId) : "")}${buildQualityNote(quality.guardrails(), { where: memoryWhere({ scope: chatId, folder: dir }), alwaysOn: alwaysOnReady })}${task}`,
    workingDir: dir,
    chatId,
    project: chat.project ?? null,
  });
  const agentName = state.addAgent(chatId, {
    id: conversation.id,
    name: finalName,
  });
  const agent = state.findAgent(chatId, agentName);
  Object.assign(agent, { task: String(task).slice(-600) }, extra);
  save();
  return agent;
}

/**
 * Hands out assignments: an existing agent with that name gets a message, a
 * new name gets a new agent. With `lead`, new agents join the lead's team.
 */
async function dispatch(chatId, assignments, lead = null) {
  const lines = [];
  for (const { name, task } of assignments) {
    try {
      const existing = lead
        ? (state
            .chat(chatId)
            .agents.find(
              (item) => item.team === lead.id && item.name === name,
            ) ?? null)
        : state.findAgent(chatId, name);
      if (existing) {
        await server.sendMessage(existing.id, task);
        markPending(existing);
        lines.push(`➡️ @${existing.name}: enviado`);
        continue;
      }
      const prompt = lead
        ? buildMemberPrompt({
            name,
            lead: lead.name,
            goal: lead.goal,
            subtask: task,
          })
        : task;
      const agent = await createAgent(chatId, {
        name,
        task: prompt,
        extra: lead ? { team: lead.id } : {},
        workingDir: lead?.workingDir ?? null,
      });
      lines.push(`🤖 @${agent.name}: creado`);
    } catch (error) {
      lines.push(`⚠️ @${name}: ${error.message}`);
    }
  }
  if (lead) state.chat(chatId).active = lead.id;
  save();
  return lines;
}

async function handleCommand(chatId, command, args, messageId, message = null) {
  const chat = state.chat(chatId);
  switch (command) {
    case "start":
    case "help":
      return say(chatId, HELP);

    case "new": {
      const { name, task, invalidName } = parseNewArgs(args);
      if (invalidName) {
        return say(
          chatId,
          `Nombre inválido "${invalidName}": usa letras, números, - o _ (máx. 32).`,
        );
      }
      if (!task) return say(chatId, "Uso: /new [@nombre] <tarea>");
      const agent = await createAgent(chatId, { name, task });
      return say(
        chatId,
        `🤖 @${agent.name} creado (${agent.id.slice(0, 8)}) en ${workingDirFor(chat)} y trabajando.\nTe aviso cuando termine.`,
        { replyTo: messageId },
        agent,
      );
    }

    case "team": {
      const { name, task, invalidName } = parseNewArgs(args);
      if (invalidName) return say(chatId, `Nombre inválido "${invalidName}".`);
      if (!task) {
        chat.pendingTeam = true;
        save();
        return say(
          chatId,
          "¡Vamos! 🙌 ¿Para qué armamos el equipo? Cuéntame el objetivo y yo lo reparto entre los agentes.",
          messageId ? { replyTo: messageId } : {},
        );
      }
      delete chat.pendingTeam;
      const lead = await createAgent(chatId, {
        name: name ?? "lider",
        task: buildLeadPrompt(task),
        extra: { role: "lead", goal: task, awaitingPlan: true },
      });
      return say(
        chatId,
        `🧭 @${lead.name} es el líder y está preparando el plan en ${workingDirFor(chat)}.\nCuando termine te enseño las subtareas con un botón para repartirlas.`,
        { replyTo: messageId },
        lead,
      );
    }

    case "dispatch": {
      const assignments = parseAssignments(args, 12);
      if (assignments.length === 0) {
        return say(
          chatId,
          "Uso (una tarea por línea):\n/dispatch\n@api añade el endpoint /health\n@web muestra el estado en el panel",
        );
      }
      const lines = await dispatch(chatId, assignments);
      return say(chatId, `📦 Reparto:\n${lines.join("\n")}`);
    }

    case "auto": {
      const value = args.toLowerCase();
      if (value === "on" || value === "off") {
        chat.auto = value === "on";
        save();
      }
      return say(
        chatId,
        isAuto(chat)
          ? "🤖 Modo automático activado: escribe tu petición y @coordinador reparte el trabajo. (/auto off para el modo manual)"
          : "✋ Modo manual: el texto va al agente activo. (/auto on para el automático)",
      );
    }

    case "dir": {
      if (!args) {
        return say(
          chatId,
          `Carpeta de trabajo: ${workingDirFor(chat)}\nCámbiala con /dir <ruta absoluta>, o /dir reset.`,
        );
      }
      if (args === "reset") {
        delete chat.workingDir;
        save();
        return say(chatId, `Carpeta de trabajo: ${config.workingDir}`);
      }
      const dir = parseWorkingDir(args);
      if (!dir)
        return say(
          chatId,
          "Usa una ruta absoluta, p. ej. /documents/mi-proyecto",
        );
      chat.workingDir = dir;
      save();
      return say(chatId, `📁 Los próximos agentes trabajarán en ${dir}`);
    }

    case "agents": {
      if (chat.agents.length === 0)
        return say(chatId, "No hay agentes. Crea uno con /new <tarea>.");
      const lines = chat.agents.map((agent, index) => {
        const marker = agent.id === chat.active ? "▶️" : "  ";
        return `${marker} ${index + 1}. @${agent.name} — ${agent.lastStatus} (${agent.id.slice(0, 8)})`;
      });
      return say(chatId, lines.join("\n"));
    }

    case "use": {
      const agent = state.findAgent(chatId, args);
      if (!agent) return say(chatId, "No encuentro ese agente. Mira /agents.");
      chat.active = agent.id;
      save();
      return say(chatId, `Agente activo: @${agent.name}`);
    }

    case "all": {
      if (!args) return say(chatId, "Uso: /all <mensaje>");
      if (chat.agents.length === 0)
        return say(chatId, "No hay agentes en este chat.");
      const results = await Promise.allSettled(
        chat.agents.map((agent) => server.sendMessage(agent.id, args)),
      );
      const ok = [];
      const failed = [];
      results.forEach((result, index) => {
        const agent = chat.agents[index];
        if (result.status === "fulfilled") {
          markPending(agent);
          ok.push(`@${agent.name}`);
        } else {
          failed.push(`@${agent.name}`);
        }
      });
      save();
      return say(
        chatId,
        `📣 Enviado a ${ok.join(", ") || "nadie"}${failed.length ? `\n⚠️ Falló: ${failed.join(", ")}` : ""}`,
      );
    }

    case "status": {
      const agent = resolveTarget(chatId, args);
      if (!agent) return say(chatId, "No hay agente activo. Mira /agents.");
      const info = await server.getConversation(agent.id);
      return say(
        chatId,
        `@${agent.name}: ${info?.execution_status ?? "desconocido"}${info?.title ? `\n${info.title}` : ""}`,
      );
    }

    case "result": {
      const agent = resolveTarget(chatId, args);
      if (!agent) return say(chatId, "No hay agente activo. Mira /agents.");
      const response = await server.finalResponse(agent.id);
      return say(
        chatId,
        `🧾 @${agent.name}:\n\n${response || "(sin respuesta todavía)"}`,
        {},
        agent,
      );
    }

    case "stop": {
      const agent = resolveTarget(chatId, args);
      if (!agent) return say(chatId, "No hay agente activo. Mira /agents.");
      await server.pause(agent.id);
      return say(chatId, `⏸️ @${agent.name} pausado.`);
    }

    case "forget": {
      const agent = state.findAgent(chatId, args);
      if (!agent) return say(chatId, "Uso: /forget <nombre>");
      state.removeAgent(chatId, agent.id);
      save();
      return say(
        chatId,
        `@${agent.name} ya no se sigue en este chat (la conversación sigue en el servidor).`,
      );
    }

    case "profiles": {
      const { profiles = [], active_agent_profile_id: activeId } =
        await server.listProfiles();
      if (profiles.length === 0)
        return say(chatId, "El servidor no tiene perfiles de agente.");
      const chosen = chat.profile ?? config.defaultProfile;
      const lines = profiles.map((profile) => {
        const tags = [];
        if ((profile.id ?? profile.name) === activeId) tags.push("activo");
        if (chosen && (profile.id === chosen || profile.name === chosen))
          tags.push("este chat");
        return `• ${profile.name} [${profile.agent_kind ?? "openhands"}]${tags.length ? ` (${tags.join(", ")})` : ""}`;
      });
      return say(chatId, lines.join("\n"));
    }

    case "profile": {
      if (!args) return say(chatId, "Uso: /profile <nombre>");
      const id = await server.resolveProfileId(args);
      if (!id)
        return say(chatId, `No existe el perfil "${args}". Mira /profiles.`);
      chat.profile = id;
      save();
      return say(
        chatId,
        `Los próximos /new de este chat usarán el perfil "${args}".`,
      );
    }

    case "insights": {
      const target = args
        ? state.findAgent(chatId, args)
        : (chat.agents.find((a) => a.id === chat.active && !a.insights) ??
          null);
      if (!target)
        return say(chatId, "Uso: /insights <nombre del agente> (mira /agents)");
      const events = [];
      let pageId = null;
      for (let page = 0; page < 20; page += 1) {
        const result = await server.listEvents(target.id, { pageId });
        events.push(...(result?.items ?? []));
        pageId = result?.next_page_id ?? null;
        if (!pageId) break;
      }
      const { digest, stats } = summarizeEvents(events);
      const agent = await createAgent(chatId, {
        name: `insights-${target.name}`.slice(0, 32),
        task: buildInsightsPrompt({
          name: target.name,
          conversationId: target.id,
          stats,
          digest,
        }),
        extra: { insights: true },
      });
      return say(
        chatId,
        `🔎 @${agent.name} analiza la sesión de @${target.name} (${stats.events} eventos). Te aviso con el informe.`,
        { replyTo: messageId },
      );
    }

    case "bots": {
      const lines = Object.entries(BOT_TEMPLATES).map(
        ([key, bot]) => `• ${key} (${bot.when}) — ${bot.description}`,
      );
      return say(
        chatId,
        `Bots disponibles:\n${lines.join("\n")}\n\nActívalo con /bot <nombre> [cuándo], p. ej. /bot latency o /bot latency viernes 10:00. Trabaja en la carpeta actual (${workingDirFor(chat)}).`,
      );
    }

    case "bot": {
      const [key = "", ...when] = args.split(/\s+/).filter(Boolean);
      const bot = BOT_TEMPLATES[key.toLowerCase()];
      if (!bot)
        return say(chatId, "Uso: /bot <plantilla> [cuándo]. Mira /bots.");
      return addSchedule(
        chatId,
        `${when.length ? when.join(" ") : bot.when} ${bot.text}`,
        { bot: key.toLowerCase() },
      );
    }

    case "schedule":
    case "schedules": {
      const [sub = "", id = ""] = args.split(/\s+/);
      const schedules = (chat.schedules ??= []);
      if (!args || sub === "list") {
        if (schedules.length === 0)
          return say(
            chatId,
            "No hay tareas programadas. Ej.: /schedule lunes 09:00 /latency  ·  /bots",
          );
        return say(
          chatId,
          schedules
            .map(
              (item) =>
                `#${item.id} ${describeSchedule(item.schedule)}${item.bot ? ` [bot ${item.bot}]` : ""} → ${item.text}\n   en ${item.workingDir} · próxima: ${formatWhen(item.nextRunAt, config.timeZone)}`,
            )
            .join("\n"),
        );
      }
      if (sub === "rm" || sub === "del" || sub === "borrar") {
        const index = schedules.findIndex((item) => String(item.id) === id);
        if (index < 0) return say(chatId, `No existe la tarea #${id}.`);
        const [removed] = schedules.splice(index, 1);
        save();
        return say(chatId, `🗑️ Tarea #${removed.id} eliminada.`);
      }
      if (sub === "run") {
        const item = schedules.find((entry) => String(entry.id) === id);
        if (!item) return say(chatId, `No existe la tarea #${id}.`);
        return runSchedule(chatId, item);
      }
      return addSchedule(chatId, args);
    }

    case "project":
    case "projects":
    case "proyecto":
    case "proyectos":
      return projectCommand(chatId, args, message);

    case "pen":
    case "foto":
    case "screen":
      return handlePen(chatId, args, messageId);

    case "ux":
      return handlePen(
        chatId,
        `revisa la ux ${args.trim() ? `de ${args.trim()} ` : ""}y optimízala`,
        messageId,
      );

    case "ship":
    case "shipit":
      return shipCommand(chatId, args, messageId, message);

    case "feedback":
      return feedbackCommand(chatId, args);

    case "ingest":
    case "ingesta":
    case "ingerir":
    case "aprende-de":
      return ingestCommand(chatId, args, messageId);

    case "memoria":
    case "memory":
      return memoryCommand(chatId, args);

    case "evals":
    case "eval":
      return evalsCommand(chatId, args, messageId);

    case "mejora":
    case "mejoras":
    case "aprende":
    case "improve":
      return improveCommand(chatId, args, messageId);

    case "consejo":
    case "council":
    case "debate": {
      const parsed = parseCouncilArgs(args);
      if (parsed.usage) {
        const open = (chat.councils ?? []).filter(
          (item) => item.phase !== "done",
        );
        const experts = Object.entries(COUNCIL_EXPERTS).map(
          ([key, info]) => `• ${key} — ${info.title}`,
        );
        return say(
          chatId,
          `${parsed.usage}\n\n${experts.join("\n")}${open.length ? `\n\nEn curso:\n${open.map((item) => `• ${item.topic} (${item.phase === "proposals" ? "propuestas" : "debate"})`).join("\n")}` : ""}`,
        );
      }
      return startCouncil(chatId, parsed, { messageId });
    }

    default:
      if (SKILL_COMMANDS.includes(command)) {
        const built = buildSkillRequest(command, args);
        if (built.usage) return say(chatId, built.usage);
        return routeToCoordinator(chatId, built.request, messageId, {
          label: `/${command}`,
        });
      }
      return say(chatId, "Comando desconocido. /help");
  }
}

/**
 * A group became a supergroup (turning on topics does this) and got a new
 * id: keep it authorized and move its agents, projects and schedules.
 */
function handleMigration(message) {
  const oldId = String(message.chat.id);
  const newId = String(message.migrate_to_chat_id);
  if (!config.allowedChats.has(oldId)) return;
  config.allowedChats.add(newId);
  const moved = state.migrateChat(oldId, newId);
  save();
  log(`chat ${oldId} migrated to ${newId}; moved ${moved} scope(s)`);
}

async function handleMessage(message) {
  const chatId = scopeOf(message);
  const parsed = parseMessage(message.text);

  if (parsed.kind === "command" && parsed.command === "whoami") {
    const { chatId: id, threadId } = splitScope(chatId);
    return say(
      chatId,
      `chat id: ${id}${threadId ? `\ntema (thread) id: ${threadId}` : ""}\nuser id: ${message.from?.id ?? "?"}${message.chat.is_forum ? "\nGrupo con temas: cada tema puede ser un proyecto (/project)." : ""}`,
    );
  }
  if (!isAuthorized(config, chatId, message.from?.id)) {
    log("ignored unauthorized chat", chatId, "user", message.from?.id);
    return;
  }

  appendChatLog(
    state.chat(chatId),
    message.from?.first_name || message.from?.username || "humano",
    message.text,
  );

  if (parsed.kind === "command") {
    return handleCommand(
      chatId,
      parsed.command,
      parsed.args,
      message.message_id,
      message,
    );
  }

  const room = state.chat(chatId);
  // The note after a 👎: "¿Qué falló?".
  const pending = room.pendingFeedback;
  if (pending && parsed.kind === "text") {
    delete room.pendingFeedback;
    save();
    const fresh = Date.now() - pending.at < 30 * 60_000;
    const repliesElsewhere =
      message.reply_to_message &&
      message.reply_to_message.message_id !== pending.messageId;
    if (fresh && !repliesElsewhere)
      return feedbackNote(chatId, pending.agentId, parsed.text, message);
  }
  if (parsed.kind === "text") {
    // "hola /team arma el login": a command written inside a sentence.
    const inline = findInlineCommand(parsed.text, KNOWN_COMMANDS);
    if (inline) {
      return handleCommand(
        chatId,
        inline.command,
        inline.args,
        message.message_id,
        message,
      );
    }
  }
  // People talking to each other in a group: read it as context, stay quiet.
  const isReplyToBot =
    Boolean(botIdentity) &&
    message.reply_to_message?.from?.id === botIdentity.id;
  if (
    parsed.kind !== "addressed" &&
    !shouldAnswer({
      chatType: message.chat?.type,
      text: message.text,
      who: message.from?.first_name || message.from?.username || "humano",
      botUsername: botIdentity?.username ?? "",
      agentNames: room.agents.map((agent) => agent.name),
      isReplyToBot,
      log: room.log ?? [],
    })
  ) {
    save();
    return;
  }
  if (parsed.kind === "text") {
    const ship = shipIntent(parsed.text);
    if (ship)
      return shipCommand(chatId, ship.extra, message.message_id, message);
    // The answer to "¿Para qué armamos el equipo?".
    if (room.pendingTeam && !message.reply_to_message) {
      return handleCommand(
        chatId,
        "team",
        parsed.text,
        message.message_id,
        message,
      );
    }
    const social = smallTalk(parsed.text);
    if (social === "greeting") {
      return say(
        chatId,
        buildGreeting({
          user: message.from?.first_name ?? "",
          agents: room.agents,
          project: room.project ?? "",
          dir: workingDirFor(room),
        }),
        { replyTo: message.message_id },
      );
    }
    if (social === "thanks") {
      return say(
        chatId,
        "¡Con gusto! 🙌 Aquí seguimos si necesitas algo más.",
        {
          replyTo: message.message_id,
        },
      );
    }
  }
  telegram.sendChatAction(chatId, "typing").catch(() => {});

  const replied = message.reply_to_message
    ? state.agentForReply(chatId, message.reply_to_message.message_id)
    : null;
  if (replied)
    return sendToAgent(chatId, replied, parsed.text, message.message_id);

  if (parsed.kind === "addressed") {
    const agent = state.findAgent(chatId, parsed.agent);
    if (agent)
      return sendToAgent(chatId, agent, parsed.text, message.message_id);
    // Not one of our agents (e.g. mentioning a person): treat as plain text.
  }

  // "pen, toma una foto de wallet" / "en pen arregla el header": pen.dev.
  const penText = penMessage(parsed.text ?? message.text);
  if (penText !== null && config.penMcpUrl) {
    return handlePen(chatId, penText, message.message_id);
  }

  // With BotFather privacy mode on (the default), a group only delivers
  // commands, @bot mentions and replies to the bot, so plain chatter between
  // people never reaches the active agent.
  if (isAuto(state.chat(chatId))) {
    return routeToCoordinator(chatId, message.text.trim(), message.message_id);
  }
  const active = state.activeAgent(chatId);
  if (!active) {
    if (message.chat.type === "private")
      await say(chatId, "No hay agente activo. Crea uno con /new <tarea>.");
    return;
  }
  return sendToAgent(chatId, active, message.text.trim(), message.message_id);
}

async function handleCallback(query) {
  const chatId = query.message ? scopeOf(query.message) : null;
  if (chatId == null || !isAuthorized(config, chatId, query.from?.id)) {
    return telegram.answerCallback(query.id, "No autorizado");
  }
  const [action, conversationId] = String(query.data ?? "").split(":");
  const chat = state.chat(chatId);
  if (action === "apply" || action === "drop")
    return handleProposal(chatId, query, action, conversationId);
  const agent = chat.agents.find((item) => item.id === conversationId);
  if (!agent) return telegram.answerCallback(query.id, "Agente desconocido");

  if (action === "up" || action === "down")
    return rateAgent(chatId, query, agent, action === "up" ? 1 : -1);

  if (action === "go" || action === "skip") {
    const plan = agent.plan ?? [];
    delete agent.plan;
    save();
    if (action === "skip" || plan.length === 0) {
      await telegram.answerCallback(query.id, "Plan descartado");
      return say(chatId, `Plan de @${agent.name} descartado.`);
    }
    await telegram.answerCallback(query.id, "Repartiendo…");
    agent.teamNotified = false;
    const lines = await dispatch(chatId, plan, agent);
    return say(
      chatId,
      `🚀 Equipo de @${agent.name}:\n${lines.join("\n")}\nTe aviso cuando terminen todos.`,
    );
  }

  if (action === "sum") {
    await telegram.answerCallback(query.id, "Enviado al líder");
    return integrate(chatId, agent);
  }

  if (action !== "ok" && action !== "no") {
    return telegram.answerCallback(query.id, "Acción desconocida");
  }
  const accept = action === "ok";
  await server.respondToConfirmation(
    agent.id,
    accept,
    accept
      ? undefined
      : `Rechazado desde Telegram por ${query.from?.username ?? query.from?.id}`,
  );
  markPending(agent);
  save();
  await telegram.answerCallback(query.id, accept ? "Aprobado" : "Rechazado");
  return say(
    chatId,
    `${accept ? "✅ Aprobado" : "❌ Rechazado"} para @${agent.name}.`,
  );
}

/** Adds a scheduled request to the chat, bound to the current folder. */
/**
 * Expert council, phase 1: one read-only agent per expert, all in parallel.
 * watchAgents moves it on: debate when all have proposed, then @moderador.
 */
async function startCouncil(
  chatId,
  { experts, topic },
  { workingDir = null, messageId = null, label = null } = {},
) {
  const chat = state.chat(chatId);
  const dir = workingDir ?? workingDirFor(chat);
  const council = {
    id: `council-${Date.now().toString(36)}`,
    topic,
    workingDir: dir,
    phase: "proposals",
    createdAt: Date.now(),
  };
  (chat.councils ??= []).push(council);
  const names = [];
  const failures = [];
  for (const expert of experts) {
    const name = state.uniqueName(chatId, expert);
    try {
      await createAgent(chatId, {
        name,
        task: buildCouncilProposalPrompt({
          expert,
          name,
          topic,
          panel: experts,
          workingDir: dir,
        }),
        extra: { team: council.id, expert },
        workingDir: dir,
      });
      names.push(name);
    } catch (error) {
      failures.push(`⚠️ @${name}: ${error.message}`);
    }
  }
  if (names.length < 2) council.phase = "done";
  save();
  return say(
    chatId,
    [
      `🏛️ ${label ? `${label}: c` : "C"}onsejo sobre "${topic}" en ${dir}`,
      `Expertos en paralelo: ${names.map((name) => `@${name}`).join(", ")}`,
      "1) cada uno propone por su cuenta (solo lectura) → 2) debaten y votan → 3) @moderador decide y te propone el plan.",
      ...failures,
      names.length < 2 ? "No se pudo formar el consejo." : "",
    ]
      .filter(Boolean)
      .join("\n"),
    messageId ? { replyTo: messageId } : {},
  );
}

/** Moves a council to its next phase once all its experts have answered. */
async function advanceCouncil(chatId, council) {
  const chat = state.chat(chatId);
  const members = chat.agents.filter((item) => item.team === council.id);
  const healthy = members.filter(
    (item) => !["error", "stuck"].includes(item.lastStatus),
  );
  const answers = [];
  for (const member of healthy) {
    answers.push({
      name: member.name,
      text: await server.finalResponse(member.id).catch(() => ""),
    });
  }
  if (council.phase === "proposals" && healthy.length >= 2) {
    council.phase = "debate";
    council.proposals = answers.map((item) => ({
      ...item,
      text: item.text.slice(0, 6000),
    }));
    save();
    for (const member of healthy) {
      await server
        .sendMessage(
          member.id,
          buildCouncilDebatePrompt({
            expert: member.name,
            topic: council.topic,
            positions: council.proposals,
          }),
        )
        .catch((error) =>
          log("debate send failed", member.name, error.message),
        );
      markPending(member);
    }
    save();
    return say(
      chatId,
      `🗣️ Debate: ${healthy.map((item) => `@${item.name}`).join(", ")} leen las propuestas de los demás, las discuten y votan su top 3.`,
    );
  }
  // Debate finished (or too few experts left to debate): the moderator decides.
  council.phase = "done";
  const proposals = council.proposals ?? answers;
  const debate = council.proposals ? answers : [];
  const tally = tallyVotes(debate);
  council.tally = tally.slice(0, 12);
  save();
  const moderator = await createAgent(chatId, {
    name: "moderador",
    task: buildCouncilDecisionPrompt({
      topic: council.topic,
      proposals,
      debate,
      tally,
      workingDir: council.workingDir,
    }),
    extra: {
      role: "lead",
      awaitingPlan: true,
      goal: council.topic,
      workingDir: council.workingDir,
      councilOf: council.id,
    },
    workingDir: council.workingDir,
  });
  council.moderator = moderator.id;
  save();
  return say(
    chatId,
    `🗳️ Votos del consejo:\n${formatTally(tally)}\n\n⚖️ @${moderator.name} está decidiendo. Te propondrá el plan para que lo apruebes.`,
    {},
    moderator,
  );
}

/**
 * Binds a scope (chat or topic) to a project. Its coordinator belongs to the
 * previous project, so it is retired (kept as a plain agent) and the next
 * request starts a new one in the new folder.
 */
function bindProject(scope, name) {
  const chat = state.chat(scope);
  if (chat.project !== name) {
    for (const agent of chat.agents) {
      if (agent.coordinator) agent.coordinator = false;
    }
  }
  chat.project = name;
  chat.workingDir = state.projects[name].dir;
  save();
}

function projectScopes(name) {
  return Object.entries(state.chats).filter(
    ([, chat]) => chat.project === name,
  );
}

async function projectCommand(scope, args, message) {
  const chat = state.chat(scope);
  const parsed = parseProjectArgs(args);
  if (parsed.usage) return say(scope, parsed.usage);
  const { action, name } = parsed;

  if (action === "list") {
    const entries = Object.entries(state.projects);
    const lines = entries.map(([key, project]) => {
      const scopes = projectScopes(key).length;
      return `${key === chat.project ? "👉" : "•"} ${key} — ${project.dir}${scopes ? ` (${scopes} chat${scopes === 1 ? "" : "s"}/tema${scopes === 1 ? "" : "s"})` : ""}`;
    });
    return say(
      scope,
      [
        chat.project
          ? `Este chat trabaja en el proyecto ${chat.project} (${workingDirFor(chat)}).`
          : `Este chat no tiene proyecto; carpeta: ${workingDirFor(chat)}.`,
        "",
        entries.length
          ? `Proyectos:\n${lines.join("\n")}`
          : "Aún no hay proyectos.",
        "",
        "/project new <nombre> [carpeta] · /project use <nombre>",
        "Tip: en un grupo con temas, cada tema es un proyecto separado con sus propios agentes.",
      ].join("\n"),
    );
  }

  if (action === "rm") {
    if (!state.projects[name])
      return say(scope, `No existe el proyecto ${name}.`);
    delete state.projects[name];
    for (const [, bound] of projectScopes(name)) delete bound.project;
    save();
    return say(
      scope,
      `🗑️ Proyecto ${name} quitado de la lista (los archivos siguen ahí).`,
    );
  }

  if (action === "use") {
    if (!state.projects[name])
      return say(
        scope,
        `No existe el proyecto ${name}. Créalo con /project new ${name} [carpeta].`,
      );
    bindProject(scope, name);
    return say(
      scope,
      `📁 Este chat ahora trabaja en ${name} (${state.projects[name].dir}). Los agentes nuevos y su memoria quedan separados por proyecto.`,
    );
  }

  // new
  const existing = state.projects[name];
  if (existing && existing.dir !== parsed.dir) {
    return say(
      scope,
      `El proyecto ${name} ya existe en ${existing.dir}. Usa /project use ${name}.`,
    );
  }
  if (!existsSync(parsed.dir)) {
    return say(
      scope,
      `La carpeta ${parsed.dir} no existe en el contenedor. Usa una carpeta dentro de /documents o /projects, p. ej. /project new ${name} /documents/${name}.`,
    );
  }
  state.projects[name] ??= { dir: parsed.dir, createdAt: Date.now() };
  save();

  // In a forum group, open a topic for the project (the bot needs the
  // "Manage topics" admin right); otherwise bind this chat.
  const { chatId, threadId } = splitScope(scope);
  if (message?.chat?.is_forum && !threadId) {
    try {
      const topic = await telegram.createForumTopic(chatId, `📁 ${name}`);
      const topicScope = `${chatId}:${topic}`;
      bindProject(topicScope, name);
      await say(
        topicScope,
        `📁 Proyecto ${name} → ${parsed.dir}\nTodo lo que escribas en este tema va a sus propios agentes, coordinador, bots y memoria.`,
      );
      return say(scope, `✅ Proyecto ${name} creado con su propio tema.`);
    } catch (error) {
      await say(
        scope,
        `No pude crear el tema (${error.message}). Dale al bot el permiso de administrador "Gestionar temas", o crea el tema a mano y escribe allí /project use ${name}.`,
      );
    }
  }
  bindProject(scope, name);
  return say(
    scope,
    `✅ Proyecto ${name} → ${parsed.dir}. Este chat trabaja ahora en él.`,
  );
}

const PEN_SHOTS_DIR = "/documents/.pen-shots";

function penClient() {
  return new McpHttpClient({
    url: config.penMcpUrl,
    token: config.penMcpToken,
  });
}

const PEN_DOWN =
  "¿Está abierta la app Pen y el servicio pen-mcp-gateway en el Mac?";

/** The open .pen document: { uri, file, nodes } (nodes: visible ones). */
async function penDocument(pen) {
  const { uri, nodes } = parsePenAppState(
    (await pen.callTool("get_app_state")).text,
  );
  if (!uri) return null;
  const file = decodeURIComponent(uri.split("/").pop() ?? uri);
  return { uri, file, nodes };
}

/** Every top-level node of the document, visible ones first. */
async function penAllNodes(pen, doc) {
  const listed = await pen.callTool("execute", {
    uri: doc.uri,
    description: "List top-level frames for Telegram",
    input: PEN_LIST_SNIPPET,
  });
  const full = parsePenNodeList(listed.text);
  const seen = new Set(doc.nodes.map((node) => node.id));
  return [...doc.nodes, ...full.filter((node) => !seen.has(node.id))];
}

/** Exports nodes as PNG through the Pen app and posts them as photos. */
async function sendPenShots(chatId, pen, doc, picked) {
  const hostDir = toPenHostPath(PEN_SHOTS_DIR);
  if (!hostDir) throw new Error("falta PEN_HOST_DOCUMENTS_DIR en docker/.env");
  const exported = await pen.callTool("execute", {
    uri: doc.uri,
    description: "Export frames for Telegram",
    input: penExportSnippet(
      picked.map((node) => node.id),
      hostDir,
    ),
  });
  if (exported.isError) throw new Error(exported.text.slice(0, 300));
  for (const node of picked) {
    const path = `${PEN_SHOTS_DIR}/${node.id}.png`;
    try {
      const data = await readFile(path);
      const caption = `${node.name ?? node.id} · ${doc.file}`;
      const filename = `${node.id}.png`;
      await telegram.sendPhoto(chatId, data, { caption, filename }).catch(() =>
        telegram.sendPhoto(chatId, data, {
          caption,
          filename,
          asDocument: true,
        }),
      );
    } catch (error) {
      await say(chatId, `⚠️ ${node.name ?? node.id}: ${error.message}`);
    } finally {
      await rm(path, { force: true }).catch(() => {});
    }
  }
}

/**
 * Talk to pen.dev in plain language (/pen …, "pen, …", "en pen …"):
 * photos and the frame list are answered by the bridge directly; any other
 * request goes to the chat's design agent @pen, whose result comes back
 * with a photo of the frames it changed.
 */
async function handlePen(chatId, text, messageId) {
  if (!config.penMcpUrl) {
    return say(
      chatId,
      "pen.dev no está conectado: falta PEN_MCP_URL en docker/.env (docs/PENCIL.md).",
    );
  }
  const reply = messageId ? { replyTo: messageId } : {};
  const request = parsePenRequest(text);
  const pen = penClient();
  try {
    const doc = await penDocument(pen);
    if (!doc) {
      return say(
        chatId,
        "No hay ningún archivo .pen abierto en la app Pen. Ábrelo y vuelve a pedírmelo.",
        reply,
      );
    }
    if (request.intent === "edit")
      return penEdit(chatId, doc, request.request, reply);
    if (request.intent === "ux") {
      const all = await penAllNodes(pen, doc);
      const frames = pickPenNodes(all, request.query, 3);
      if (request.query && !frames.length) {
        return say(
          chatId,
          `No encontré una pantalla "${request.query}" en ${doc.file}. Pide "pen lista" para ver los nombres.`,
          reply,
        );
      }
      return penUx(chatId, doc, request.request, frames, reply);
    }

    const all =
      request.intent === "list" || request.query
        ? await penAllNodes(pen, doc)
        : doc.nodes;
    if (request.intent === "list") {
      const frames = all.filter((node) => node.type === "frame");
      return say(
        chatId,
        `🎨 ${doc.file}: ${frames.length} pantallas\n${frames
          .slice(0, 60)
          .map((node) => `• ${node.name} (${node.id})`)
          .join(
            "\n",
          )}${frames.length > 60 ? "\n…" : ""}\n\nPídeme una: "pen, foto de wallet".`,
        reply,
      );
    }
    const picked = pickPenNodes(all, request.query, request.only ? 1 : 4);
    if (!picked.length) {
      return say(
        chatId,
        `No encontré una pantalla "${request.query}" en ${doc.file}. Pide "pen lista" para ver los nombres.`,
        reply,
      );
    }
    await say(
      chatId,
      `📸 ${picked.map((node) => node.name).join(", ")}…`,
      reply,
    );
    await sendPenShots(chatId, pen, doc, picked);
    return null;
  } catch (error) {
    return say(
      chatId,
      `⚠️ No pude hablar con pen.dev: ${error.message}\n${PEN_DOWN}`,
      reply,
    );
  } finally {
    await pen.close();
  }
}

/** The chat's UX agent @ux reviews frames and optimizes them on copies. */
async function penUx(chatId, doc, request, frames, reply) {
  const chat = state.chat(chatId);
  const prompt = buildPenUxPrompt({
    request,
    uri: doc.uri,
    file: doc.file,
    frames: frames.map(({ id, name }) => ({ id, name })),
  });
  let agent = chat.agents.find((item) => item.uxAgent);
  if (agent) {
    await server.sendMessage(agent.id, prompt);
    markPending(agent);
  } else {
    agent = await createAgent(chatId, {
      name: "ux",
      task: prompt,
      extra: { uxAgent: true },
    });
  }
  agent.penPending = true;
  save();
  return say(
    chatId,
    `🧑‍🎨 @${agent.name} revisa ${frames.length ? frames.map((frame) => frame.name).join(", ") : "las pantallas visibles"} en ${doc.file}: hallazgos de UX priorizados y una copia "· UX v2" optimizada de cada una (los originales no se tocan). Te mando el antes y el después.`,
    reply,
    agent,
  );
}

/** Sends a change request to the chat's design agent @pen (created on demand). */
async function penEdit(chatId, doc, request, reply) {
  const chat = state.chat(chatId);
  const prompt = buildPenEditPrompt({ request, uri: doc.uri, file: doc.file });
  let agent = chat.agents.find((item) => item.penAgent);
  if (agent) {
    await server.sendMessage(agent.id, prompt);
    markPending(agent);
  } else {
    agent = await createAgent(chatId, {
      name: "pen",
      task: prompt,
      extra: { penAgent: true },
    });
  }
  agent.penPending = true;
  save();
  return say(
    chatId,
    `🎨 @${agent.name} está haciendo el cambio en ${doc.file}. Lo verás en vivo en Pen y te mando la foto al terminar.`,
    reply,
    agent,
  );
}

/** After @pen finishes: photos of the frames it names in its FOTO: line. */
async function penAgentDone(chatId, agent, response) {
  agent.penPending = false;
  const ids = parsePhotoIds(response);
  if (!ids.length || !config.penMcpUrl) return;
  const pen = penClient();
  try {
    const doc = await penDocument(pen);
    if (!doc) return;
    const all = await penAllNodes(pen, doc);
    const picked = ids.map(
      (id) => all.find((node) => node.id === id) ?? { id, name: id },
    );
    await sendPenShots(chatId, pen, doc, picked);
  } catch (error) {
    await say(chatId, `⚠️ No pude sacar la foto del cambio: ${error.message}`);
  } finally {
    await pen.close();
  }
}

function addSchedule(chatId, args, extra = {}) {
  const chat = state.chat(chatId);
  const parsed = parseScheduleArgs(args);
  if (parsed.error) return say(chatId, `⚠️ ${parsed.error}`);
  const first = nextRun(parsed.schedule, Date.now(), config.timeZone);
  if (!first) return say(chatId, "⚠️ No pude calcular la próxima ejecución.");
  const schedules = (chat.schedules ??= []);
  const id = Math.max(0, ...schedules.map((item) => item.id)) + 1;
  const item = {
    id,
    schedule: parsed.schedule,
    text: parsed.text,
    workingDir: workingDirFor(chat),
    nextRunAt: first,
    createdAt: Date.now(),
    ...extra,
  };
  schedules.push(item);
  save();
  return say(
    chatId,
    `⏰ Tarea #${id} programada: ${describeSchedule(item.schedule)} (${config.timeZone}) → ${item.text}\nCarpeta: ${item.workingDir}\nPrimera ejecución: ${formatWhen(first, config.timeZone)}. /schedule rm ${id} para quitarla.`,
  );
}

/** Runs one scheduled entry now through the coordinator. */
async function runSchedule(chatId, item) {
  item.lastRunAt = Date.now();
  save();
  const council = /^\/(?:consejo|council|debate)(?:@\S+)?\s+([\s\S]+)$/i.exec(
    item.text.trim(),
  );
  const direct = parseMessage(item.text.trim());
  if (
    direct.kind === "command" &&
    ["evals", "eval", "mejora", "aprende", "improve"].includes(direct.command)
  ) {
    return handleCommand(chatId, direct.command, direct.args, null);
  }
  if (council) {
    const parsed = parseCouncilArgs(council[1]);
    if (parsed.usage) return say(chatId, parsed.usage);
    return startCouncil(chatId, parsed, {
      workingDir: item.workingDir,
      label: `⏰ Tarea #${item.id}${item.bot ? ` (bot ${item.bot})` : ""}`,
    });
  }
  return routeToCoordinator(chatId, expandScheduledText(item.text), null, {
    workingDir: item.workingDir,
    label: `⏰ Tarea #${item.id}${item.bot ? ` (bot ${item.bot})` : ""}`,
  });
}

/** Fires every schedule whose time has come, then books its next run. */
async function runSchedules() {
  const now = Date.now();
  for (const [chatId, chat] of Object.entries(state.chats)) {
    for (const item of chat.schedules ?? []) {
      if (!item.nextRunAt || item.nextRunAt > now) continue;
      // Book the next run first, so a failure can't make it fire in a loop.
      item.nextRunAt = nextRun(item.schedule, now, config.timeZone);
      save();
      try {
        await runSchedule(chatId, item);
      } catch (error) {
        log("schedule failed", item.id, error.message);
        await say(
          chatId,
          `⚠️ La tarea #${item.id} falló: ${error.message}`,
        ).catch(() => {});
      }
    }
  }
}

/**
 * Delivers the "PARA @name: …" lines of a finished agent to the other agents
 * of the same chat or topic, and posts each one so humans can follow along.
 */
async function relayAgentMessages(chatId, from, response) {
  // Council experts debate through the council's own rounds.
  if (from.expert) return;
  const chat = state.chat(chatId);
  for (const { to, text } of parseAgentMessages(response)) {
    if (to === from.name) continue;
    const target = chat.agents.find((item) => item.name === to);
    if (!target) {
      await say(
        chatId,
        `💬 @${from.name} → @${to}: no hay ningún agente @${to} aquí. Respóndele tú o créalo con /new @${to} <tarea>.\n${text}`,
        {},
        from,
      );
      continue;
    }
    if (!allowRelay(from)) {
      await say(
        chatId,
        `⏸️ @${from.name} ya envió muchos mensajes a otros agentes esta hora. Respóndele tú para seguir.`,
        {},
        from,
      );
      return;
    }
    await say(
      chatId,
      `💬 @${from.name} → @${target.name}: ${text}`,
      {},
      target,
    );
    await server.sendMessage(target.id, buildRelayPrompt(from.name, text));
    markPending(target);
  }
  save();
}

/** Polls tracked agents and posts results, errors and confirmation requests. */
async function watchAgents() {
  for (const [chatId, chat] of Object.entries(state.chats)) {
    for (const agent of [...chat.agents]) {
      try {
        const info = await server.getConversation(agent.id);
        delete agent.missing;
        const next = info?.execution_status;
        const event = statusTransition(agent.lastStatus, next);
        if (next === "running") {
          agent.seenRunning = true;
          await reportProgress(chatId, agent);
        }
        // A new turn reports idle before it starts running: not a result.
        if (event === "done" && next === "idle" && !agent.seenRunning) continue;
        if (next) agent.lastStatus = next;
        // Any non-running state ends the turn: the next run announces itself.
        if (next && next !== "running") delete agent.runningSince;
        // A fast agent can finish between polls; "finished" proves it ran.
        if (event === "done") agent.seenRunning = true;
        if (event === "done") {
          const raw = await server.finalResponse(agent.id).catch(() => "");
          // The coordinator decided the message needed no answer.
          if (agent.coordinator && /^\s*NOOP\s*$/.test(raw)) {
            agent.awaitingPlan = false;
            save();
            continue;
          }
          delete agent.shipping;
          if (await qualityAgentDone(chatId, agent, raw)) continue;
          const response = await postResult(chatId, agent, raw);
          if (agent.awaitingPlan) await offerPlan(chatId, agent, response);
          if (agent.penPending) await penAgentDone(chatId, agent, response);
          await relayAgentMessages(chatId, agent, response);
        } else if (event === "problem" && agent.evalCase) {
          await evalCaseDone(
            chatId,
            agent,
            `(el agente quedó en estado "${next}")`,
          );
        } else if (event === "problem") {
          const reason =
            next === "error"
              ? explainError(await server.lastError(agent.id).catch(() => null))
              : "";
          await say(
            chatId,
            `⚠️ @${agent.name} está en estado "${next}".${reason ? `\n${reason}` : ""}\nResponde a este mensaje para guiarlo.`,
            {},
            agent,
          );
        } else if (event === "confirm") {
          await say(
            chatId,
            `🔐 @${agent.name} pide confirmación para una acción. Revísala en Agent Canvas o decide aquí:`,
            {
              keyboard: [
                [
                  { text: "✅ Aprobar", callback_data: `ok:${agent.id}` },
                  { text: "❌ Rechazar", callback_data: `no:${agent.id}` },
                ],
              ],
            },
            agent,
          );
        }
      } catch (error) {
        // A deleted conversation answers 404 forever: stop tracking it.
        if (
          /HTTP 404/.test(error.message) &&
          (agent.missing = (agent.missing ?? 0) + 1) >= 3
        ) {
          chat.agents = chat.agents.filter((item) => item !== agent);
          log("dropped agent with a deleted conversation:", agent.name);
          save();
        } else log("watch failed for", agent.name, error.message);
      }
    }
    for (const lead of chat.agents.filter((item) => item.role === "lead")) {
      if (lead.teamNotified || !teamDone(chat.agents, lead.id)) continue;
      lead.teamNotified = true;
      if (isAuto(chat) && lead.coordinator) {
        await say(chatId, `🏁 Terminó el equipo de @${lead.name}.`).catch(
          () => {},
        );
        await integrate(chatId, lead).catch((error) =>
          log("auto integrate failed", error.message),
        );
        continue;
      }
      const members = chat.agents
        .filter((item) => item.team === lead.id)
        .map((item) => `@${item.name} (${item.lastStatus})`);
      await say(
        chatId,
        `🏁 El equipo de @${lead.name} terminó: ${members.join(", ")}.`,
        {
          keyboard: [
            [
              {
                text: `🧩 Pedir a @${lead.name} que integre`,
                callback_data: `sum:${lead.id}`,
              },
            ],
          ],
        },
        lead,
      ).catch((error) => log("team notice failed", error.message));
    }
    for (const council of chat.councils ?? []) {
      if (council.phase === "done" || !teamDone(chat.agents, council.id))
        continue;
      await advanceCouncil(chatId, council).catch((error) => {
        log("council failed", council.id, error.message);
        council.phase = "done";
        return say(
          chatId,
          `⚠️ El consejo "${council.topic}" falló: ${error.message}`,
        ).catch(() => {});
      });
    }
  }
  save();
}

// ---------------------------------------------------------------------------
// Feedback loop: results with 👍/👎, evals (@juez), proposals (@curador)
// ---------------------------------------------------------------------------

const MAX_RECENT_WORK = 20;
const isReadOnly = (agent) =>
  Boolean(agent.expert || agent.insights || agent.judgeOf || agent.curator);

/**
 * Posts a finished answer after the automatic checks (secrets hidden, risky
 * commands, missing VERIFICACIÓN), with 👍/👎 buttons, and remembers it for
 * /evals. Returns the text that was posted.
 */
async function postResult(chatId, agent, raw) {
  const review = reviewAnswer(raw, { coding: !isReadOnly(agent) });
  const text = review.text || "terminé, pero no dejé un mensaje final.";
  await say(
    chatId,
    `✅ @${agent.name}: ${text}${review.notes.length ? `\n\n${review.notes.join("\n")}` : ""}`,
    {
      keyboard: [
        [
          { text: "👍", callback_data: `up:${agent.id}` },
          { text: "👎", callback_data: `down:${agent.id}` },
        ],
      ],
    },
    agent,
  );
  const chat = state.chat(chatId);
  const work = (chat.recentWork ??= []);
  work.push({
    id: `${agent.name}-${Date.now().toString(36)}`,
    agentId: agent.id,
    agent: agent.name,
    task: agent.lastAsk ?? agent.task ?? "",
    response: text.slice(0, 4000),
    at: Date.now(),
  });
  chat.recentWork = work.slice(-MAX_RECENT_WORK);
  if (review.negative) {
    quality.addFeedback({
      scope: chatId,
      project: chat.project ?? null,
      agent: agent.name,
      task: (agent.lastAsk ?? agent.task ?? "").slice(0, 400),
      response: text.slice(0, 400),
      rating: -1,
      source: "auto",
      note: review.reasons.join("; "),
    });
  }
  save();
  return text;
}

function feedbackBase(chatId, agent) {
  const chat = state.chat(chatId);
  const last = [...(chat.recentWork ?? [])]
    .reverse()
    .find((item) => item.agentId === agent.id);
  return {
    scope: chatId,
    project: chat.project ?? null,
    agent: agent.name,
    task: (last?.task ?? agent.lastAsk ?? agent.task ?? "").slice(0, 400),
    response: (last?.response ?? "").slice(0, 400),
  };
}

async function rateAgent(chatId, query, agent, rating) {
  quality.addFeedback({
    ...feedbackBase(chatId, agent),
    rating,
    source: "human",
    user: query.from?.username ?? String(query.from?.id ?? ""),
  });
  if (rating > 0) {
    await telegram.answerCallback(query.id, "¡Gracias! 👍");
    return;
  }
  await telegram.answerCallback(query.id, "Anotado 👎");
  const [sent] = await say(
    chatId,
    `👎 Anotado. ¿Qué falló con @${agent.name}? Cuéntamelo en un mensaje y se lo paso para que lo corrija (o escribe "nada").`,
  );
  const chat = state.chat(chatId);
  chat.pendingFeedback = {
    agentId: agent.id,
    at: Date.now(),
    messageId: sent?.message_id ?? null,
  };
  save();
}

async function feedbackNote(chatId, agentId, note, message) {
  const agent = state.chat(chatId).agents.find((item) => item.id === agentId);
  if (!agent || /^(nada|no|skip|nothing|ninguno)\.?$/i.test(note.trim())) {
    return say(chatId, "Vale, queda solo el 👎.", {
      replyTo: message.message_id,
    });
  }
  quality.addFeedback({
    ...feedbackBase(chatId, agent),
    rating: 0,
    about: "down",
    note: note.slice(0, 1000),
    source: "human",
    user: message.from?.username ?? String(message.from?.id ?? ""),
  });
  await server.sendMessage(agent.id, buildFeedbackPrompt(note));
  const base = feedbackBase(chatId, agent);
  learn(
    chatId,
    `Human feedback on a task like "${base.task.slice(0, 160)}": ${note}`,
    { agent: agent.name, origin: "feedback" },
  ).catch(() => {});
  agent.lastAsk = `(corrección) ${note}`.slice(0, 600);
  markPending(agent);
  save();
  return say(
    chatId,
    `📝 Gracias, lo anoto para que el equipo aprenda y se lo paso a @${agent.name} para que lo corrija.`,
    { replyTo: message.message_id },
  );
}

async function feedbackCommand(chatId, args) {
  const addressed = /^@([\w-]{1,32})\s+([\s\S]+)$/.exec(args.trim());
  if (addressed) {
    const agent = state.findAgent(chatId, addressed[1]);
    if (!agent) return say(chatId, `No encuentro a @${addressed[1]}.`);
    const note = addressed[2].trim();
    const rating = /^👍/.test(note) ? 1 : /^👎/.test(note) ? -1 : 0;
    quality.addFeedback({
      ...feedbackBase(chatId, agent),
      rating,
      note: note
        .replace(/^👍|^👎/, "")
        .trim()
        .slice(0, 1000),
      source: "human",
    });
    return say(
      chatId,
      `📝 Nota para @${agent.name} guardada. /mejora la usará.`,
    );
  }
  const entries = quality.feedback({ scope: chatId });
  if (entries.length === 0) {
    return say(
      chatId,
      "Aún no hay valoraciones. Usa 👍/👎 bajo cada resultado, o /feedback @agente <nota>.",
    );
  }
  const stats = Object.entries(feedbackStats(entries))
    .sort((a, b) => b[1].down + b[1].auto - (a[1].down + a[1].auto))
    .map(
      ([name, row]) =>
        `@${name}: 👍 ${row.up} · 👎 ${row.down} · ⚠️ auto ${row.auto}`,
    );
  const notes = entries
    .filter((item) => item.note && item.source !== "auto")
    .slice(-5)
    .map((item) => `• @${item.agent}: ${item.note.slice(0, 160)}`);
  return say(
    chatId,
    `📈 Feedback de este chat (${entries.length}):\n${stats.join("\n")}${notes.length ? `\n\nÚltimas notas:\n${notes.join("\n")}` : ""}\n\n/mejora convierte esto en skills, reglas o evals.`,
  );
}

// --- evals ------------------------------------------------------------------

async function evalsCommand(chatId, args, messageId) {
  const chat = state.chat(chatId);
  const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const kind = sub.toLowerCase();

  if (kind === "skills") {
    const rows = [
      ...(BUILTIN_SKILLS_DIR ? lintSkillsDir(BUILTIN_SKILLS_DIR) : []),
      ...lintSkillsDir(quality.skillsDir).map((row) => ({
        ...row,
        name: `${row.name} (aprendida)`,
      })),
    ];
    const bad = rows.filter((row) => row.problems.length);
    return say(
      chatId,
      `🧰 Skills: ${rows.length - bad.length}/${rows.length} sin problemas.${bad.length ? `\n${bad.map((row) => `• ${row.name}: ${row.problems.join("; ")}`).join("\n")}` : ""}`,
    );
  }

  if (kind === "historial" || kind === "history") {
    const results = quality.evals({ scope: chatId });
    if (results.length === 0)
      return say(chatId, "Aún no hay evals. Prueba /evals casos.");
    const runs = new Map();
    for (const item of results) {
      const run = runs.get(item.runId) ?? {
        kind: item.kind,
        at: item.at,
        scores: [],
        passed: 0,
        total: 0,
      };
      run.scores.push(item.score);
      if (item.passed !== undefined) {
        run.total += 1;
        if (item.passed) run.passed += 1;
      }
      runs.set(item.runId, run);
    }
    const lines = [...runs.values()].slice(-10).map((run) => {
      const average =
        Math.round(
          (run.scores.reduce((a, b) => a + b, 0) / run.scores.length) * 10,
        ) / 10;
      return `• ${formatWhen(run.at, config.timeZone)} ${run.kind === "cases" ? "casos" : "trabajo"}: ${average}/5${run.total ? ` · ${run.passed}/${run.total} pasan` : ""}`;
    });
    return say(chatId, `📊 Historial de evals:\n${lines.join("\n")}`);
  }

  const busy = (chat.evalRuns ?? []).find((run) => run.phase !== "done");
  if (
    busy &&
    (kind === "casos" || kind === "cases" || kind === "revisar" || kind === "")
  ) {
    if (Date.now() - busy.startedAt < 3 * 3600_000) {
      return say(
        chatId,
        `⏳ Ya hay una evaluación en curso (${busy.kind === "cases" ? "casos" : "trabajo reciente"}). Te aviso al terminar.`,
      );
    }
    busy.phase = "done"; // stale: let a new one start
  }

  if (kind === "casos" || kind === "cases")
    return runEvalCases(chatId, rest, messageId);
  if (
    kind === "" ||
    kind === "revisar" ||
    kind === "review" ||
    /^\d+$/.test(kind)
  ) {
    const count = Number(/^\d+$/.test(kind) ? kind : rest[0]) || 8;
    return judgeRecentWork(chatId, Math.min(count, 15), messageId);
  }
  return say(
    chatId,
    "Uso: /evals (puntúa el trabajo reciente) · /evals casos [id…] · /evals skills · /evals historial",
  );
}

async function judgeRecentWork(chatId, count, messageId) {
  const chat = state.chat(chatId);
  const work = (chat.recentWork ?? []).slice(-count);
  if (work.length === 0) {
    return say(
      chatId,
      "No hay trabajo reciente que evaluar en este chat. Prueba /evals casos.",
    );
  }
  const notes = quality.feedback({ scope: chatId });
  const items = work.map((item) => {
    const human = notes.filter(
      (entry) =>
        entry.agent === item.agent &&
        entry.at >= item.at &&
        entry.source === "human",
    );
    return {
      id: item.id,
      agent: item.agent,
      task: item.task,
      response: item.response,
      feedback:
        human
          .map((entry) =>
            entry.rating > 0
              ? "👍"
              : entry.rating < 0
                ? "👎"
                : `"${entry.note}"`,
          )
          .join(" ") || "",
    };
  });
  const run = {
    id: `eval-${Date.now().toString(36)}`,
    kind: "work",
    phase: "judging",
    startedAt: Date.now(),
    items: items.map(({ id, agent }) => ({ id, agent })),
  };
  (chat.evalRuns ??= []).push(run);
  chat.evalRuns = chat.evalRuns.slice(-10);
  const judge = await createAgent(chatId, {
    name: "juez",
    task: buildJudgePrompt({
      items,
      workingDir: workingDirFor(chat),
      purpose: "score the team's recent work in this chat",
    }),
    extra: { judgeOf: run.id },
  });
  run.judge = judge.id;
  save();
  return say(
    chatId,
    `⚖️ @${judge.name} evalúa ${items.length} respuesta(s) recientes con la rúbrica: tarea, verificación, calidad, seguridad y comunicación. Te paso la puntuación.`,
    messageId ? { replyTo: messageId } : {},
  );
}

async function runEvalCases(chatId, ids, messageId) {
  const chat = state.chat(chatId);
  const cases = allCases().filter(
    (item) => ids.length === 0 || ids.includes(item.id),
  );
  if (cases.length === 0) {
    return say(
      chatId,
      `No hay casos${ids.length ? ` con id ${ids.join(", ")}` : ""}. Casos: ${
        allCases()
          .map((item) => item.id)
          .join(", ") || "ninguno"
      }`,
    );
  }
  pruneRuns(quality.runsDir, 3);
  const run = {
    id: `eval-${Date.now().toString(36)}`,
    kind: "cases",
    phase: "running",
    startedAt: Date.now(),
    cases: [],
  };
  run.dir = join(quality.runsDir, run.id);
  (chat.evalRuns ??= []).push(run);
  chat.evalRuns = chat.evalRuns.slice(-10);
  const lines = [];
  for (const evalCase of cases) {
    const { dir, hashes } = prepareCase(evalCase, run.dir);
    const entry = { id: evalCase.id, dir, hashes, done: false };
    try {
      const agent = await createAgent(chatId, {
        name: `eval-${evalCase.id}`.slice(0, 32),
        task: buildCaseRunPrompt(evalCase, dir),
        extra: {
          evalRun: run.id,
          evalCase: evalCase.id,
          task: evalCase.prompt,
        },
        workingDir: dir,
      });
      entry.agentId = agent.id;
      lines.push(
        `🧪 ${evalCase.id}${evalCase.source === "learned" ? " (aprendido)" : ""}`,
      );
    } catch (error) {
      entry.done = true;
      entry.response = `(no se pudo crear el agente: ${error.message})`;
      lines.push(`⚠️ ${evalCase.id}: ${error.message}`);
    }
    run.cases.push(entry);
  }
  save();
  await say(
    chatId,
    `🧪 Evaluación con ${cases.length} caso(s), cada uno en su carpeta de prueba:\n${lines.join("\n")}\nCuando terminen, @juez los puntúa y comparo con la vez anterior.`,
    messageId ? { replyTo: messageId } : {},
  );
  return maybeJudgeCases(chatId, run);
}

async function evalCaseDone(chatId, agent, response) {
  const chat = state.chat(chatId);
  const run = (chat.evalRuns ?? []).find((item) => item.id === agent.evalRun);
  const entry = run?.cases.find((item) => item.id === agent.evalCase);
  if (entry && !entry.done) {
    entry.done = true;
    entry.response = String(response ?? "").slice(0, 6000);
  }
  state.removeAgent(chatId, agent.id);
  save();
  if (run) await maybeJudgeCases(chatId, run);
}

async function maybeJudgeCases(chatId, run) {
  if (run.phase !== "running" || run.cases.some((item) => !item.done)) return;
  run.phase = "judging";
  save();
  const cases = allCases();
  const items = [];
  for (const entry of run.cases) {
    const evalCase = cases.find((item) => item.id === entry.id);
    entry.checks = evalCase
      ? await checkCase(evalCase, entry, entry.response)
      : [];
    items.push({
      id: entry.id,
      agent: `eval-${entry.id}`,
      task: evalCase?.prompt ?? entry.id,
      expect: evalCase?.expect ?? [],
      checks: entry.checks,
      response: entry.response,
    });
  }
  const judge = await createAgent(chatId, {
    name: "juez",
    task: buildJudgePrompt({
      items,
      workingDir: run.dir,
      purpose:
        "grade the eval cases; each case's scratch folder is <folder>/<id>",
    }),
    extra: { judgeOf: run.id },
    workingDir: run.dir,
  });
  run.judge = judge.id;
  save();
  const failed = run.cases.filter((item) =>
    item.checks.some((check) => !check.ok),
  );
  return say(
    chatId,
    `⚖️ Casos terminados. Chequeos automáticos: ${run.cases.length - failed.length}/${run.cases.length} sin fallos${failed.length ? ` (fallan: ${failed.map((item) => item.id).join(", ")})` : ""}. @${judge.name} está puntuando.`,
  );
}

async function judgeDone(chatId, agent, raw) {
  const chat = state.chat(chatId);
  const run = (chat.evalRuns ?? []).find((item) => item.id === agent.judgeOf);
  state.removeAgent(chatId, agent.id);
  if (!run) return save();
  run.phase = "done";
  const results = parseEvalLines(raw);
  const summary = String(raw ?? "")
    .replace(/^\s*EVAL\s+\{.*\}\s*$/gm, "")
    .trim()
    .slice(0, 1500);
  if (results.length === 0) {
    save();
    return say(
      chatId,
      `⚠️ @juez no dejó puntuaciones que pueda leer.\n\n${summary}`,
    );
  }
  const previous = quality.evals({ scope: chatId });
  const rows = results.map((result) => {
    const entry = run.cases?.find((item) => item.id === result.id);
    const known = run.items?.find((item) => item.id === result.id);
    const key =
      run.kind === "cases"
        ? result.id
        : `@${known?.agent ?? result.id.replace(/-[a-z0-9]+$/, "")}`;
    const evalCase = entry
      ? allCases().find((item) => item.id === entry.id)
      : null;
    const passed = entry
      ? casePassed({
          checks: entry.checks,
          expectTotal: evalCase?.expect?.length ?? 0,
          result,
        })
      : undefined;
    const fallos = [
      ...(entry?.checks ?? [])
        .filter((check) => !check.ok)
        .map((check) => `chequeo: ${check.name}`),
      ...result.fallos,
    ];
    return {
      key,
      score: result.score,
      scores: result.scores,
      passed,
      fallos,
      mejora: result.mejora,
    };
  });
  // Recent work: one row per agent (average of its answers).
  const merged =
    run.kind === "cases"
      ? rows
      : Object.values(
          rows.reduce((acc, row) => {
            const item = (acc[row.key] ??= { ...row, all: [] });
            item.all.push(row.score);
            item.fallos = [...new Set([...item.fallos, ...row.fallos])].slice(
              0,
              4,
            );
            item.score =
              Math.round(
                (item.all.reduce((a, b) => a + b, 0) / item.all.length) * 10,
              ) / 10;
            return acc;
          }, {}),
        );
  const lastByKey = new Map();
  for (const item of previous.filter((entry) => entry.kind === run.kind))
    lastByKey.set(item.key, item.score);
  const board = formatScoreboard(
    merged,
    [...lastByKey].map(([key, score]) => ({ key, score })),
  );
  for (const row of merged) {
    quality.addEvalResult({
      scope: chatId,
      project: chat.project ?? null,
      kind: run.kind,
      runId: run.id,
      key: row.key,
      score: row.score,
      scores: row.scores,
      passed: row.passed,
      fallos: row.fallos,
      mejora: row.mejora,
    });
  }
  save();
  for (const row of merged.filter(
    (item) => (item.score < 3.5 || item.passed === false) && item.mejora,
  )) {
    learn(chatId, `Eval ${row.key} (${row.score}/5): ${row.mejora}`, {
      origin: "eval",
      evidence: row.fallos.join("; "),
    }).catch(() => {});
  }
  // Automejora: failed evals start @curador (at most once a day).
  const weak = merged.some((row) => row.score < 3.5 || row.passed === false);
  if (
    weak &&
    chat.autoImprove !== false &&
    Date.now() - (chat.lastAutoImproveAt ?? 0) > 20 * 3600_000
  ) {
    chat.lastAutoImproveAt = Date.now();
    save();
    improveCommand(chatId, "lo que falló en los últimos evals", null).catch(
      (error) => log("auto improve failed", error.message),
    );
  }
  const passedCount = merged.filter((row) => row.passed).length;
  return say(
    chatId,
    `📊 Evals ${run.kind === "cases" ? `(casos): ${passedCount}/${merged.length} pasan` : "(trabajo reciente)"} · media ${board.average}/5\n${board.text}${summary ? `\n\n${summary}` : ""}\n\n${merged.some((row) => row.score < 3.5 || row.passed === false) ? "/mejora propone skills, reglas o casos para lo que falló." : "Todo en verde 🎉"}`,
  );
}

// --- proposals ----------------------------------------------------------------

async function improveCommand(chatId, args, messageId) {
  const chat = state.chat(chatId);
  const [sub = "", type = "", ...rest] = args
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (sub === "auto") {
    if (type === "on" || type === "off") {
      chat.autoImprove = type === "on";
      save();
    }
    return say(
      chatId,
      chat.autoImprove === false
        ? "✋ Automejora apagada: todas las propuestas esperan tu ✅. (/mejora auto on)"
        : "🤖 Automejora encendida: tras evals con fallos, @curador propone y aplico solas las reglas y casos que pasan la validación; las skills nuevas siempre esperan tu ✅. Deshaz cualquier cosa con /mejora quitar. (/mejora auto off)",
    );
  }
  if (sub === "lista" || sub === "list") {
    const rules = quality.guardrails();
    const skills = quality.learnedSkills();
    const cases = quality.learnedCases();
    return say(
      chatId,
      [
        "🧠 Lo aprendido (vale para todos los agentes nuevos):",
        `Reglas (${rules.length}):${rules.length ? `\n${rules.map((rule, index) => `${index + 1}. ${rule}`).join("\n")}` : " ninguna"}`,
        `Skills: ${skills.join(", ") || "ninguna"}`,
        `Casos de eval: ${cases.map((item) => item.id).join(", ") || "ninguno"}`,
        "Quitar: /mejora quitar regla <n> | skill <nombre> | eval <id>",
      ].join("\n"),
    );
  }
  if (sub === "quitar" || sub === "rm" || sub === "remove") {
    const target = rest.join(" ");
    let done = false;
    if (type === "regla" || type === "rule")
      done = Boolean(quality.removeGuardrail(Number(target) - 1));
    if (done && (type === "regla" || type === "rule")) syncAlwaysOn();
    else if (type === "skill") {
      done = quality.removeSkill(target);
      if (done) uninstallSkill(target, SKILL_TARGETS);
    } else if (type === "eval" || type === "caso")
      done = quality.removeCase(target);
    return say(
      chatId,
      done
        ? `🗑️ Quitado: ${type} ${target}.`
        : "No lo encontré. Mira /mejora lista.",
    );
  }
  const curator = await createAgent(chatId, {
    name: "curador",
    task: buildCuratorPrompt({
      feedback: quality.feedback({ limit: 200 }),
      evals: quality.evals({ limit: 100 }),
      skills: builtinSkills(),
      learnedSkills: quality.learnedSkills(),
      guardrails: quality.guardrails(),
      cases: allCases(),
      focus: args.trim(),
      workingDir: workingDirFor(chat),
    }),
    extra: { curator: true },
  });
  save();
  return say(
    chatId,
    `🧠 @${curator.name} revisa el feedback y los evals para proponer mecanismos nuevos (skills, reglas o casos). Tú apruebas cada uno.`,
    messageId ? { replyTo: messageId } : {},
  );
}

async function curatorDone(chatId, agent, raw) {
  const chat = state.chat(chatId);
  state.removeAgent(chatId, agent.id);
  const context = {
    builtinSkills: builtinSkills(),
    learnedSkills: quality.learnedSkills(),
    guardrails: quality.guardrails(),
    cases: allCases(),
  };
  const parsed = parseProposals(raw);
  const summary = String(raw ?? "")
    .replace(/PROPUESTA\s*\n[\s\S]*?>>>/g, "")
    .trim()
    .slice(0, 1200);
  if (parsed.length === 0) {
    save();
    return say(
      chatId,
      `🧠 @curador no propone mecanismos nuevos.\n\n${summary}`,
    );
  }
  const rejected = [];
  chat.proposals = (chat.proposals ?? [])
    .filter((item) => item.status === "pending")
    .slice(-10);
  for (const proposal of parsed) {
    const checked = validateProposal(proposal, context);
    if (checked.error) {
      rejected.push(
        `• ${proposal.type} ${proposal.name || "?"}: ${checked.error}`,
      );
      continue;
    }
    const item = {
      ...checked,
      id: `p${Date.now().toString(36)}${chat.proposals.length}`,
      status: "pending",
      createdAt: Date.now(),
    };
    chat.proposals.push(item);
    if (chat.autoImprove !== false && item.type !== "skill") {
      if (await applyProposal(chatId, item, "automejora")) continue;
    }
    const icon = { skill: "🧰", guardrail: "🛡️", eval: "🧪" }[item.type];
    await say(
      chatId,
      `${icon} Propuesta: ${item.type} "${item.name}"${item.replaces ? " (reemplaza la aprendida)" : ""}\n${item.reason}\nEvidencia: ${item.evidence || "—"}\n\n${item.content.slice(0, 1500)}${item.content.length > 1500 ? "\n…" : ""}`,
      {
        keyboard: [
          [
            { text: "✅ Aplicar", callback_data: `apply:${item.id}` },
            { text: "✖️ Descartar", callback_data: `drop:${item.id}` },
          ],
        ],
      },
    );
  }
  save();
  return say(
    chatId,
    `${rejected.length ? `Descarté ${rejected.length} propuesta(s) que no pasan la validación:\n${rejected.join("\n")}\n\n` : ""}${summary}`,
  );
}

async function handleProposal(chatId, query, action, id) {
  const chat = state.chat(chatId);
  const item = (chat.proposals ?? []).find((entry) => entry.id === id);
  if (!item || item.status !== "pending")
    return telegram.answerCallback(query.id, "Ya no está pendiente");
  const who = query.from?.username ?? query.from?.id;
  if (action === "drop") {
    item.status = "dropped";
    save();
    await telegram.answerCallback(query.id, "Descartada");
    return say(chatId, `✖️ Propuesta "${item.name}" descartada por ${who}.`);
  }
  const applied = await applyProposal(chatId, item, String(who ?? ""));
  await telegram.answerCallback(query.id, applied ? "Aplicada" : "Falló");
}

/** Applies a validated proposal, saves it as a lesson and reports it. */
async function applyProposal(chatId, item, who) {
  try {
    if (item.type === "guardrail") {
      quality.addGuardrail(item.content);
      syncAlwaysOn();
    } else if (item.type === "skill") {
      quality.writeSkill(item.name, item.content);
      installLearnedSkills(quality, SKILL_TARGETS);
    } else quality.writeCase(JSON.parse(item.content));
  } catch (error) {
    await say(chatId, `⚠️ No pude aplicar "${item.name}": ${error.message}`);
    return false;
  }
  item.status = "applied";
  item.appliedBy = who;
  save();
  learn(
    chatId,
    item.type === "guardrail"
      ? `Team rule: ${item.content}`
      : `New ${item.type} "${item.name}": ${item.reason}`,
    { origin: "mejora", evidence: item.evidence },
  ).catch(() => {});
  const effect = {
    guardrail: "Los agentes nuevos ya siguen esta regla.",
    skill: "Los agentes nuevos ya tienen esta skill.",
    eval: "Entra en el próximo /evals casos.",
  }[item.type];
  const undo =
    item.type === "guardrail" ? "regla <n>" : `${item.type} ${item.name}`;
  await say(
    chatId,
    `${who === "automejora" ? "🤖 Aplicada sola (automejora)" : `✅ Aplicada por ${who}`}: ${item.type} "${item.name}". ${effect}${item.type === "guardrail" ? `\n${item.content}` : ""}\n/evals casos mide si mejora · /mejora quitar ${undo} para deshacerlo.`,
  );
  return true;
}

/** Eval, judge and curator agents report through the loop, not as results. */
async function qualityAgentDone(chatId, agent, raw) {
  if (agent.evalCase) {
    await evalCaseDone(chatId, agent, raw);
    return true;
  }
  if (agent.judgeOf) {
    await judgeDone(chatId, agent, raw);
    return true;
  }
  if (agent.curator) {
    await curatorDone(chatId, agent, raw);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Team memory: ingest data, lessons from feedback, /memoria
// ---------------------------------------------------------------------------

const KNOWLEDGE_ROOTS = (
  process.env.KNOWLEDGE_ROOTS || "/projects,/documents,/workspace"
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const UPLOADS_DIR = join(quality.dir, "uploads");
const qdrantRest = process.env.QDRANT_URL
  ? new QdrantRest({
      url: process.env.QDRANT_URL,
      collection: process.env.MEMORY_COLLECTION || "agent-memory",
    })
  : null;
let memoryMcp = null;

async function memoryTools() {
  if (!process.env.QDRANT_URL)
    throw new Error("la memoria (QDRANT_URL) no está configurada");
  if (memoryMcp?.running) return memoryMcp;
  const server = buildMemoryMcpServer(process.env);
  memoryMcp = new McpStdioClient({ command: server.command, env: server.env });
  await memoryMcp.start();
  return memoryMcp;
}

const memoryStore = async (information, metadata) =>
  (await memoryTools()).callTool("qdrant-store", { information, metadata });

/** Saves a lesson in the shared memory; never fails the caller. */
async function learn(
  chatId,
  lesson,
  { agent = null, origin = "feedback", evidence = "" } = {},
) {
  if (!process.env.QDRANT_URL || !String(lesson ?? "").trim()) return false;
  try {
    const note = buildLessonNote({
      lesson,
      project: state.chat(chatId).project ?? null,
      agent,
      origin,
      evidence,
      where: whereOf(chatId),
    });
    await storeNotes([note], { store: memoryStore, rest: qdrantRest });
    return true;
  } catch (error) {
    log("lesson not stored", error.message);
    if (!memoryMcp?.running) memoryMcp = null;
    return false;
  }
}

async function ingestCommand(chatId, args, messageId) {
  const chat = state.chat(chatId);
  const raw = args.trim();
  if (!raw) {
    return say(
      chatId,
      "Uso: /ingest <ruta | carpeta | URL> — lo guardo en la memoria del equipo (Qdrant) para que todos los agentes lo encuentren. También puedes mandarme un archivo (md, txt, csv, json, código, html).",
    );
  }
  const source = /^https?:\/\//i.test(raw)
    ? raw
    : resolve(workingDirFor(chat), raw);
  telegram.sendChatAction(chatId, "typing").catch(() => {});
  try {
    const result = await ingestSource(source, {
      store: memoryStore,
      rest: qdrantRest,
      project: chat.project ?? null,
      // It belongs to this topic's workspace, wherever the file lives.
      scope: chatId,
      folder: workingDirFor(chat),
      allowedRoots: /^https?:/i.test(source) ? [] : KNOWLEDGE_ROOTS,
    });
    const repo = !/^https?:/i.test(source) ? findRepoRoot(source) : null;
    if (repo) runGraphify(["update", repo], repo, 30 * 60_000).catch(() => {});
    return say(
      chatId,
      `🧠 Ingerido en la memoria: ${result.sources} fuente(s), ${result.chunks} fragmento(s)${result.skipped.length ? ` · omití ${result.skipped.length} (binarios, secretos o vacíos)` : ""}.${repo ? `\n🕸️ Actualizando el grafo de ${repo}.` : ""}\nLos agentes de este tema lo encuentran con memory_search.`,
      messageId ? { replyTo: messageId } : {},
    );
  } catch (error) {
    if (!memoryMcp?.running) memoryMcp = null;
    return say(chatId, `⚠️ No pude ingerir ${raw}: ${error.message}`);
  }
}

/** A file sent to the chat: saved, ingested, and the caption (if any) handled. */
async function handleDocument(message) {
  const chatId = scopeOf(message);
  if (!isAuthorized(config, chatId, message.from?.id)) return;
  const doc = message.document;
  const name = String(doc.file_name || `archivo-${doc.file_unique_id}`)
    .replace(/[^\w.@-]+/g, "_")
    .slice(-120);
  if ((doc.file_size ?? 0) > 20 * 1024 * 1024)
    return say(
      chatId,
      "⚠️ El archivo pasa de 20 MB (límite de Telegram para bots).",
    );
  if (!ingestible(name, doc.file_size ?? 0))
    return say(
      chatId,
      `⚠️ No ingiero "${name}": solo texto, docs y código (no binarios ni archivos de secretos).`,
      { replyTo: message.message_id },
    );
  try {
    const data = await telegram.downloadFile(doc.file_id);
    const dir = join(UPLOADS_DIR, String(chatId).replace(/[^\w-]/g, "_"));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, data);
    const chat = state.chat(chatId);
    const text = readSourceFile(path) ?? "";
    const notes = buildChunkNotes({
      text,
      source: `telegram:${chatId}/${name}`,
      title: name,
      project: chat.project ?? null,
      kind: "document",
      tags: ["telegram"],
      where: whereOf(chatId),
    });
    const chunks = await storeNotes(notes, {
      store: memoryStore,
      rest: qdrantRest,
    });
    appendChatLog(
      chat,
      message.from?.first_name || "humano",
      `(archivo ${name})`,
    );
    await say(
      chatId,
      `🧠 Guardé "${name}" en la memoria del equipo (${chunks} fragmento(s)).`,
      { replyTo: message.message_id },
    );
    const caption = String(message.caption ?? "").trim();
    if (
      caption &&
      !/^(aprende|ingesta|ingiere|memoria|guarda|ingest)\b/i.test(caption)
    ) {
      return routeToCoordinator(
        chatId,
        `${caption}\n\n(El usuario adjuntó ${name}: está en ${path} y en la memoria; búscalo con qdrant-find.)`,
        message.message_id,
      );
    }
  } catch (error) {
    if (!memoryMcp?.running) memoryMcp = null;
    return say(chatId, `⚠️ No pude guardar "${name}": ${error.message}`);
  }
}

async function memoryCommand(chatId, args) {
  const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (!process.env.QDRANT_URL)
    return say(
      chatId,
      "La memoria (QDRANT_URL) no está configurada en este contenedor.",
    );
  const where = whereOf(chatId);
  if (sub === "buscar" || sub === "search" || sub === "find") {
    const level = MEMORY_LEVELS.includes(rest[0]) ? rest.shift() : "tema";
    const query = rest.join(" ");
    if (!query)
      return say(
        chatId,
        "Uso: /memoria buscar [tema|carpeta|workspace|todo] <qué> — por defecto solo este tema y su workspace.",
      );
    try {
      const filter = memoryFilter(where, level);
      const result = await (
        await memoryTools()
      ).callTool("qdrant-find", {
        query,
        ...(filter ? { query_filter: filter } : {}),
      });
      const found = (result?.content ?? [])
        .map((item) => item.text)
        .join("\n")
        .trim();
      return say(
        chatId,
        `🔎 Memoria (${level}${where.workspace && level !== "todo" ? ` · ${level === "carpeta" ? where.folder : where.workspace}` : ""}) — "${query}":\n\n${(found && !/^No information found/i.test(found) ? found : "Nada encontrado.").slice(0, 3500)}`,
      );
    } catch (error) {
      memoryMcp = null;
      return say(chatId, `⚠️ Búsqueda fallida: ${error.message}`);
    }
  }
  if (sub === "aprende" || sub === "learn") {
    const lesson = rest.join(" ");
    if (!lesson)
      return say(
        chatId,
        "Uso: /memoria aprende <lección para los agentes de este tema y su workspace>",
      );
    return say(
      chatId,
      (await learn(chatId, lesson, { origin: "human" }))
        ? "🧠 Lección guardada en la memoria de este tema."
        : "⚠️ No pude guardarla.",
    );
  }
  try {
    const filter = memoryFilter(where, "tema");
    const counts = await qdrantRest.countByType(
      ["conversation-summary", "project-doc", "document", "web", "lesson"],
      filter,
    );
    const mine = await qdrantRest.count(filter);
    const total = await qdrantRest.count();
    const labels = {
      "conversation-summary": "resúmenes de conversaciones",
      "project-doc": "docs de proyectos",
      document: "documentos",
      web: "páginas web",
      lesson: "lecciones",
    };
    return say(
      chatId,
      [
        `🧠 Memoria de este tema (${where.workspace ?? "sin carpeta"}): ${mine} de ${total} notas`,
        ...Object.entries(counts).map(
          ([key, value]) => `• ${labels[key]}: ${value}`,
        ),
        `🛡️ Reglas aprendidas: ${quality.guardrails().length} · 🧰 skills aprendidas: ${quality.learnedSkills().length} · automejora ${state.chat(chatId).autoImprove === false ? "off" : "on"}`,
        "Separada por tema, workspace y carpeta; todos los agentes (Telegram y OpenHands) usan memory_search + grafo graphify siempre.",
        "/memoria buscar [tema|carpeta|workspace|todo] <q> · /memoria aprende <lección> · /ingest <ruta|URL> · manda un archivo",
      ].join("\n"),
    );
  } catch (error) {
    return say(chatId, `⚠️ No pude leer la memoria: ${error.message}`);
  }
}

/** After a lead's first answer, offer to hand out the plan it wrote. */
async function offerPlan(chatId, lead, response) {
  lead.awaitingPlan = false;
  const plan = parseAssignments(response);
  if (plan.length === 0) {
    if (lead.coordinator) return; // it answered directly; already posted
    await say(
      chatId,
      `@${lead.name} no dejó un plan con líneas "@nombre: tarea". Responde a su mensaje para pedírselo, o reparte tú con /dispatch.`,
      {},
      lead,
    );
    return;
  }
  const chat = state.chat(chatId);
  if (
    isAuto(chat) &&
    lead.coordinator &&
    (lead.rounds ?? 0) < MAX_AUTO_ROUNDS
  ) {
    lead.rounds = (lead.rounds ?? 0) + 1;
    lead.teamNotified = false;
    const lines = await dispatch(chatId, plan, lead);
    return say(
      chatId,
      `🚀 @${lead.name} repartió el trabajo (ronda ${lead.rounds}/${MAX_AUTO_ROUNDS}):\n${plan.map((item) => `• @${item.name}: ${item.task}`).join("\n")}\n\n${lines.join("\n")}\nTe aviso cuando terminen.`,
      {},
      lead,
    );
  }
  lead.plan = plan;
  save();
  await say(
    chatId,
    `📋 Plan de @${lead.name}:\n${plan.map((item) => `• @${item.name}: ${item.task}`).join("\n")}`,
    {
      keyboard: [
        [
          {
            text: `🚀 Repartir ${plan.length} tarea${plan.length === 1 ? "" : "s"}`,
            callback_data: `go:${lead.id}`,
          },
          { text: "✖️ Descartar", callback_data: `skip:${lead.id}` },
        ],
      ],
    },
    lead,
  );
}

async function pollTelegram() {
  for (;;) {
    try {
      const updates = await telegram.getUpdates(state.offset, 30);
      for (const update of updates) {
        state.offset = update.update_id + 1;
        save();
        try {
          if (update.message?.migrate_to_chat_id)
            handleMigration(update.message);
          else if (update.message?.text) await handleMessage(update.message);
          else if (update.message?.document)
            await handleDocument(update.message);
          else if (update.callback_query)
            await handleCallback(update.callback_query);
        } catch (error) {
          log("update failed", error.message);
          const source = update.message ?? update.callback_query?.message;
          const chatId = source ? scopeOf(source) : null;
          if (
            chatId != null &&
            isAuthorized(
              config,
              chatId,
              update.message?.from?.id ?? update.callback_query?.from?.id,
            )
          ) {
            await say(chatId, `⚠️ Error: ${error.message}`).catch(() => {});
          }
        }
      }
    } catch (error) {
      log("getUpdates failed", error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// ── agent_chat MCP server ──────────────────────────────────────────────────

function chatContext({ chat, from }) {
  const scope = String(chat ?? "");
  if (
    !state.chats[scope] ||
    !config.allowedChats.has(splitScope(scope).chatId)
  ) {
    throw new Error(
      `Unknown chat "${scope}". Use the chat id from your first message.`,
    );
  }
  const room = state.chat(scope);
  const name = String(from ?? "")
    .replace(/^@/, "")
    .toLowerCase();
  const agent = room.agents.find((item) => item.name === name);
  if (!agent)
    throw new Error(`No agent @${name} in this chat. Use your own name.`);
  return { scope, room, agent };
}

const MAX_POSTS_PER_HOUR = 20;

const chatHandlers = {
  async chat_agents(args) {
    const { room } = chatContext(args);
    return room.agents
      .map((item) => {
        const role = item.coordinator
          ? "coordinator"
          : item.penAgent
            ? "pen.dev design"
            : item.uxAgent
              ? "UX review"
              : item.expert
                ? `council expert (${item.expert})`
                : item.team
                  ? "team member"
                  : "agent";
        return `@${item.name} — ${role}, ${item.lastStatus ?? "unknown"}`;
      })
      .join("\n");
  },
  async chat_history(args) {
    const { room } = chatContext(args);
    return formatChatLog(room.log, args.limit);
  },
  async chat_send(args) {
    const { scope, room, agent } = chatContext(args);
    const to = String(args.to ?? "")
      .replace(/^@/, "")
      .toLowerCase();
    const target = room.agents.find((item) => item.name === to);
    if (!target) throw new Error(`No agent @${to} here. Call chat_agents.`);
    if (target.id === agent.id) throw new Error("That's you.");
    if (!allowRelay(agent)) {
      throw new Error(
        "Too many messages to other agents this hour. Ask the humans with chat_ask_human.",
      );
    }
    const text = String(args.text ?? "").trim();
    if (!text) throw new Error("Empty message.");
    await say(
      scope,
      `💬 @${agent.name} → @${target.name}: ${text}`,
      {},
      target,
    );
    await server.sendMessage(target.id, buildRelayPrompt(agent.name, text));
    markPending(target);
    save();
    return `Sent to @${target.name}. Its answer will arrive as a new message; keep working meanwhile.`;
  },
  async chat_post(args) {
    const { scope, agent } = chatContext(args);
    if (!allowRelay(agent, Date.now(), MAX_POSTS_PER_HOUR)) {
      throw new Error("Too many chat posts this hour.");
    }
    await say(
      scope,
      `🤖 @${agent.name}: ${String(args.text ?? "").trim()}`,
      {},
      agent,
    );
    save();
    return "Posted. Replies to it come back to you.";
  },
  async chat_ask_human(args) {
    const { scope, agent } = chatContext(args);
    if (!allowRelay(agent, Date.now(), MAX_POSTS_PER_HOUR)) {
      throw new Error("Too many questions this hour.");
    }
    await say(
      scope,
      `❓ @${agent.name} pregunta: ${String(args.question ?? "").trim()}\n(Responde a este mensaje para contestarle)`,
      {},
      agent,
    );
    save();
    return "Asked. The answer arrives as a new message; continue with what you can meanwhile.";
  },
};

function chatMcpToken() {
  state.chatMcpToken ??= randomBytes(24).toString("hex");
  save();
  return state.chatMcpToken;
}

/** Serves the agent_chat MCP tools on loopback (Streamable HTTP, JSON). */
function startChatMcpServer() {
  if (!config.chatMcpPort) return;
  const token = chatMcpToken();
  const http = createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (new URL(req.url ?? "/", "http://x").pathname !== "/mcp")
      return send(404, { error: "not found" });
    if (req.headers.authorization !== `Bearer ${token}`)
      return send(401, { error: "unauthorized" });
    if (req.method === "DELETE") return send(200);
    if (req.method !== "POST")
      return send(405, { error: "method not allowed" }, { Allow: "POST" });
    let payload;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }
    const batch = Array.isArray(payload);
    const results = (
      await Promise.all(
        (batch ? payload : [payload]).map((item) =>
          handleMcpMessage(item, chatHandlers),
        ),
      )
    ).filter(Boolean);
    const headers = { "Mcp-Session-Id": "agent-chat" };
    if (!results.length) return send(202, undefined, headers);
    return send(200, batch ? results : results[0], headers);
  });
  http.listen(config.chatMcpPort, "127.0.0.1", () =>
    log(`agent_chat MCP on http://127.0.0.1:${config.chatMcpPort}/mcp`),
  );
  http.on("error", (error) => log("agent_chat MCP failed", error.message));
}

/** Registers agent_chat for every agent (unless the user disabled it). */
async function registerChatMcp() {
  if (!config.chatMcpPort) return;
  const base = config.agentServerUrl.replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };
  if (config.sessionApiKey) headers["X-Session-API-Key"] = config.sessionApiKey;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/settings`, { headers });
      if (response.ok) {
        const existing = (await response.json()).agent_settings?.mcp_config?.[
          CHAT_MCP_KEY
        ];
        if (existing?.enabled === false)
          return log("agent_chat MCP disabled by the user");
        // POST creates; an existing entry is updated (PATCH) in place.
        const saved = await fetch(`${base}/api/settings/mcp/${CHAT_MCP_KEY}`, {
          method: existing ? "PATCH" : "POST",
          headers,
          body: JSON.stringify({
            url: `http://127.0.0.1:${config.chatMcpPort}/mcp`,
            transport: "http",
            auth: { strategy: "bearer", value: chatMcpToken() },
            description:
              "Talk to the other agents and the humans of the Telegram chat",
          }),
        });
        return log(
          saved.ok
            ? "agent_chat MCP registered for all agents"
            : `agent_chat MCP registration failed: HTTP ${saved.status}`,
        );
      }
    } catch {
      // agent server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

async function main() {
  let me;
  try {
    me = await telegram.getMe();
    botIdentity = me;
  } catch (error) {
    throw new Error(
      `Telegram rejected TELEGRAM_BOT_TOKEN (${error.message}). Check the token from @BotFather.`,
    );
  }
  if (state.switchBot(me.id)) {
    log(
      `Bot changed to @${me.username}: reset update offset and reply map; agents kept.`,
    );
  }
  for (const [oldId, newId] of Object.entries(state.migrations)) {
    if (config.allowedChats.has(oldId)) config.allowedChats.add(newId);
  }
  save();
  log(`Connected as @${me.username}`);
  if (me.can_read_all_group_messages === false) {
    log(
      "Privacy mode is ON: in groups the bot only sees commands, @mentions and replies. For natural chat, @BotFather → /setprivacy → Disable, then remove and re-add the bot to the group.",
    );
  }
  if (config.allowedChats.size === 0) {
    log(
      "SETUP MODE: TELEGRAM_ALLOWED_CHAT_IDS is empty, so only /whoami is answered.",
    );
    log(
      "Send /whoami to the bot, then restart with TELEGRAM_ALLOWED_CHAT_IDS=<chat id>.",
    );
  } else {
    log(
      `Telegram bridge → ${config.agentServerUrl} (chats: ${[...config.allowedChats].join(", ")})`,
    );
  }
  const learned = installLearnedSkills(quality, SKILL_TARGETS);
  if (learned.length) log(`Learned skills installed: ${learned.join(", ")}`);
  const always = syncAlwaysOn();
  if (always.length) log(`Team protocol always on in: ${always.join(", ")}`);
  startChatMcpServer();
  registerChatMcp().catch((error) =>
    log("agent_chat MCP registration", error.message),
  );
  await telegram
    .setCommands(COMMANDS)
    .catch((error) => log("setMyCommands failed", error.message));
  const watch = async () => {
    await watchAgents();
    await runSchedules().catch((error) =>
      log("schedules failed", error.message),
    );
    setTimeout(watch, config.pollMs);
  };
  setTimeout(watch, config.pollMs);
  await pollTelegram();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

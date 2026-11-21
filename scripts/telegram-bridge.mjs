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

import {
  AgentServerClient,
  BOT_TEMPLATES,
  BridgeState,
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
  buildCoordinatorPrompt,
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

/new <tarea> — crea un agente nuevo con esa tarea
/new @nombre <tarea> — igual, con nombre propio
/team [@nombre] <tarea> — un agente líder planifica y reparte subtareas
/dispatch — reparte tareas a mano, una por línea: @nombre tarea
/dir [ruta] — carpeta de trabajo de los próximos agentes (p. ej. /documents/mi-proyecto)
/agents — lista los agentes de este chat
/use <nombre|n> — elige el agente activo
@nombre <mensaje> — habla con un agente concreto
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

Bots y tareas programadas:
/bots — plantillas de bots siempre activos (latency, qa, scans, security, deps, wiki)
/bot <plantilla> [cuándo] — activa un bot en este chat y carpeta
/schedule <cuándo> <texto o /comando> — programa una tarea (diario 09:00, lunes 09:00, laborables 08:30, cada 6h)
/schedule — lista las tareas · /schedule rm <id> · /schedule run <id>

/profiles — perfiles de agente del servidor
/profile <nombre> — perfil para los próximos /new de este chat
/whoami — muestra el id de este chat`;

const COMMANDS = [
  ["auto", "Modo automático on/off"],
  ["new", "Crear un agente con una tarea"],
  ["team", "Líder que planifica y reparte subtareas"],
  ["dispatch", "Repartir tareas: @nombre tarea por línea"],
  ["dir", "Carpeta de trabajo de los próximos agentes"],
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
  ["bots", "Plantillas de bots"],
  ["bot", "Activar un bot programado"],
  ["schedule", "Tareas programadas"],
  ["profiles", "Perfiles de agente"],
  ["help", "Ayuda"],
].map(([command, description]) => ({ command, description }));

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

async function say(chatId, text, extra = {}, agent = null) {
  const sent = await telegram.sendText(chatId, text, extra);
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
    await say(chatId, `▶️ @${agent.name} está trabajando…`, {}, agent);
    return;
  }
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
  const prompt = buildCoordinatorPrompt(text, { workingDir: dir });
  let lead = coordinatorOf(chat);
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
  });
  chat.active = lead.id;
  save();
  return say(
    chatId,
    label
      ? `🧭 ${label} → @${lead.name} en ${dir}. Te iré avisando.`
      : `🧭 @${lead.name} recibió tu petición. Si hace falta, repartirá el trabajo entre subagentes y te iré avisando.`,
    messageId ? { replyTo: messageId } : {},
    lead,
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
  const conversation = await server.createConversation({
    profileId,
    task,
    workingDir: workingDir ?? workingDirFor(chat),
    chatId,
  });
  const agentName = state.addAgent(chatId, { id: conversation.id, name });
  const agent = state.findAgent(chatId, agentName);
  Object.assign(agent, extra);
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

async function handleCommand(chatId, command, args, messageId) {
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
      if (!task) return say(chatId, "Uso: /team [@nombre] <tarea>");
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

async function handleMessage(message) {
  const chatId = message.chat.id;
  const parsed = parseMessage(message.text);

  if (parsed.kind === "command" && parsed.command === "whoami") {
    return say(
      chatId,
      `chat id: ${chatId}\nuser id: ${message.from?.id ?? "?"}`,
    );
  }
  if (!isAuthorized(config, chatId, message.from?.id)) {
    log("ignored unauthorized chat", chatId, "user", message.from?.id);
    return;
  }

  if (parsed.kind === "command") {
    return handleCommand(
      chatId,
      parsed.command,
      parsed.args,
      message.message_id,
    );
  }

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
  const chatId = query.message?.chat.id;
  if (chatId == null || !isAuthorized(config, chatId, query.from?.id)) {
    return telegram.answerCallback(query.id, "No autorizado");
  }
  const [action, conversationId] = String(query.data ?? "").split(":");
  const chat = state.chat(chatId);
  const agent = chat.agents.find((item) => item.id === conversationId);
  if (!agent) return telegram.answerCallback(query.id, "Agente desconocido");

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

/** Polls tracked agents and posts results, errors and confirmation requests. */
async function watchAgents() {
  for (const [chatId, chat] of Object.entries(state.chats)) {
    for (const agent of chat.agents) {
      try {
        const info = await server.getConversation(agent.id);
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
          const response = await server.finalResponse(agent.id).catch(() => "");
          await say(
            chatId,
            `✅ @${agent.name} terminó:\n\n${response || "(sin respuesta final)"}`,
            {},
            agent,
          );
          if (agent.awaitingPlan) await offerPlan(chatId, agent, response);
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
        log("watch failed for", agent.name, error.message);
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
  }
  save();
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
          if (update.message?.text) await handleMessage(update.message);
          else if (update.callback_query)
            await handleCallback(update.callback_query);
        } catch (error) {
          log("update failed", error.message);
          const chatId =
            update.message?.chat.id ?? update.callback_query?.message?.chat.id;
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

async function main() {
  let me;
  try {
    me = await telegram.getMe();
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
  save();
  log(`Connected as @${me.username}`);
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

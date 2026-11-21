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
  BridgeState,
  TelegramClient,
  isAuthorized,
  loadConfig,
  parseMessage,
  parseNewArgs,
  statusTransition,
} from "./telegram-bridge-lib.mjs";

const HELP = `Puente OpenHands ↔ Telegram

/new <tarea> — crea un agente nuevo con esa tarea
/new @nombre <tarea> — igual, con nombre propio
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
/profiles — perfiles de agente del servidor
/profile <nombre> — perfil para los próximos /new de este chat
/whoami — muestra el id de este chat`;

const COMMANDS = [
  ["new", "Crear un agente con una tarea"],
  ["agents", "Listar agentes del chat"],
  ["use", "Elegir agente activo"],
  ["all", "Mensaje a todos los agentes"],
  ["status", "Estado de un agente"],
  ["result", "Última respuesta de un agente"],
  ["stop", "Pausar un agente"],
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

function resolveTarget(chatId, ref) {
  return ref ? state.findAgent(chatId, ref) : state.activeAgent(chatId);
}

async function sendToAgent(chatId, agent, text, replyTo) {
  await server.sendMessage(agent.id, text);
  agent.lastStatus = "pending";
  save();
  await say(chatId, `➡️ Enviado a @${agent.name}`, { replyTo });
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
      const profileId = await server.resolveProfileId(
        chat.profile ?? config.defaultProfile,
      );
      if (!profileId) {
        return say(
          chatId,
          "No hay perfil de agente. Crea uno en Agent Canvas (Ajustes → Agente) o usa /profiles.",
        );
      }
      const conversation = await server.createConversation({
        profileId,
        task,
        workingDir: config.workingDir,
        chatId,
      });
      const agentName = state.addAgent(chatId, { id: conversation.id, name });
      save();
      const agent = state.findAgent(chatId, agentName);
      return say(
        chatId,
        `🤖 @${agentName} creado (${conversation.id.slice(0, 8)}) y trabajando.\nTe aviso cuando termine.`,
        { replyTo: messageId },
        agent,
      );
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
          agent.lastStatus = "pending";
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

    default:
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
  const agent = state
    .chat(chatId)
    .agents.find((item) => item.id === conversationId);
  if (!agent || (action !== "ok" && action !== "no")) {
    return telegram.answerCallback(query.id, "Agente desconocido");
  }
  const accept = action === "ok";
  await server.respondToConfirmation(
    agent.id,
    accept,
    accept
      ? undefined
      : `Rechazado desde Telegram por ${query.from?.username ?? query.from?.id}`,
  );
  agent.lastStatus = "pending";
  save();
  await telegram.answerCallback(query.id, accept ? "Aprobado" : "Rechazado");
  return say(
    chatId,
    `${accept ? "✅ Aprobado" : "❌ Rechazado"} para @${agent.name}.`,
  );
}

/** Polls tracked agents and posts results, errors and confirmation requests. */
async function watchAgents() {
  for (const [chatId, chat] of Object.entries(state.chats)) {
    for (const agent of chat.agents) {
      try {
        const info = await server.getConversation(agent.id);
        const next = info?.execution_status;
        const event = statusTransition(agent.lastStatus, next);
        if (next) agent.lastStatus = next;
        if (event === "done") {
          const response = await server.finalResponse(agent.id).catch(() => "");
          await say(
            chatId,
            `✅ @${agent.name} terminó:\n\n${response || "(sin respuesta final)"}`,
            {},
            agent,
          );
        } else if (event === "problem") {
          await say(
            chatId,
            `⚠️ @${agent.name} está en estado "${next}". Responde a este mensaje para guiarlo.`,
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
  }
  save();
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
    setTimeout(watch, config.pollMs);
  };
  setTimeout(watch, config.pollMs);
  await pollTelegram();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

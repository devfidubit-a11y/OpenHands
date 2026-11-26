#!/usr/bin/env node
/**
 * `simulator` MCP server (stdio) for iPhone/iPad simulators and Flutter on
 * the macOS host (docs/MOBILE.md).
 *
 * The agents run in a Linux container, where neither Xcode nor the iOS
 * Simulator exist. This server runs on the Mac, behind
 * scripts/pen-mcp-gateway.mjs (the generic stdio → HTTP gateway), installed
 * by scripts/install-sim-mcp-gateway.sh. Agents reach it at
 * http://host.docker.internal:8932/mcp.
 *
 * Tools: sim_list, sim_boot, sim_shutdown, sim_screenshot, sim_open_url,
 * sim_install, sim_launch, sim_terminate, sim_appearance, sim_logs, sim_ui
 * (tap/swipe/type/describe, needs AXe), flutter_run_ios, flutter_cmd.
 *
 * Env: SIM_MCP_PATH_MAP ("/projects=/Users/me/projects", comma-separated;
 * container paths agents pass are translated, and Flutter only runs inside
 * the mapped host folders), FLUTTER_BIN (default "flutter" in PATH), AXE_BIN
 * (default "axe" in PATH).
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MINUTE = 60_000;

/** "/projects=/Users/me/p,/documents=/Users/me/d" → [{from, to}]. */
export function parsePathMap(raw = "") {
  return String(raw)
    .split(",")
    .map((pair) => pair.split("="))
    .filter((parts) => parts.length === 2 && parts[0].trim() && parts[1].trim())
    .map(([from, to]) => ({
      from: resolve(from.trim()),
      to: resolve(to.trim()),
    }));
}

const inside = (path, root) => path === root || path.startsWith(`${root}/`);

/**
 * A path an agent gave (container or host) as a host path inside a mapped
 * folder, or an error. With no map, any absolute host path is accepted.
 */
export function hostPath(path, map) {
  if (!path || typeof path !== "string") throw new Error("falta la ruta");
  const abs = resolve(path);
  if (map.length === 0) return abs;
  for (const { from, to } of map) {
    if (inside(abs, from)) return to + abs.slice(from.length);
    if (inside(abs, to)) return abs;
  }
  throw new Error(
    `ruta fuera de las carpetas compartidas (${map.map((m) => m.from).join(", ")})`,
  );
}

/** `xcrun simctl list devices available -j` → flat device list. */
export function parseDevices(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  const out = [];
  for (const [runtime, devices] of Object.entries(data?.devices ?? {})) {
    const os = /SimRuntime\.(\w+)-([\d-]+)$/.exec(runtime);
    for (const device of devices) {
      if (device.isAvailable === false) continue;
      out.push({
        name: device.name,
        udid: device.udid,
        state: device.state,
        os: os ? `${os[1]} ${os[2].replace(/-/g, ".")}` : runtime,
      });
    }
  }
  return out;
}

/**
 * The device for a name, a UDID or nothing (the booted one; when several
 * share a name, the booted one or the newest OS).
 */
export function pickDevice(devices, wanted) {
  const value = String(wanted ?? "").trim();
  if (!value || value === "booted") {
    const booted = devices.find((d) => d.state === "Booted");
    if (!booted)
      throw new Error(
        "no hay simulador encendido; usa sim_boot con un nombre de sim_list",
      );
    return booted;
  }
  const byId = devices.find(
    (d) => d.udid.toLowerCase() === value.toLowerCase(),
  );
  if (byId) return byId;
  const named = devices.filter(
    (d) => d.name.toLowerCase() === value.toLowerCase(),
  );
  if (named.length === 0)
    throw new Error(`no existe el simulador "${value}"; mira sim_list`);
  return (
    named.find((d) => d.state === "Booted") ??
    [...named].sort((a, b) =>
      b.os.localeCompare(a.os, undefined, { numeric: true }),
    )[0]
  );
}

export const FLUTTER_SUBCOMMANDS = new Set([
  "pub",
  "analyze",
  "test",
  "build",
  "clean",
  "gen-l10n",
  "doctor",
  "devices",
  "--version",
  "format",
]);

/** Validates flutter_cmd args: no `run`/`attach` (interactive), no shell. */
export function flutterArgs(args) {
  const list = Array.isArray(args)
    ? args.map(String)
    : String(args ?? "")
        .split(/\s+/)
        .filter(Boolean);
  if (list.length === 0) throw new Error("faltan los argumentos de flutter");
  if (!FLUTTER_SUBCOMMANDS.has(list[0]))
    throw new Error(
      `flutter ${list[0]} no está permitido; usa ${[...FLUTTER_SUBCOMMANDS].join(", ")} (para abrir la app usa flutter_run_ios)`,
    );
  return list;
}

export const SIM_TOOLS = [
  {
    name: "sim_list",
    description:
      "List the iPhone/iPad simulators on the Mac host (name, UDID, iOS version, Booted/Shutdown).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sim_boot",
    description:
      "Boot a simulator (name like 'iPhone 17 Pro' or UDID) and open the Simulator app so the user can watch.",
    inputSchema: {
      type: "object",
      properties: { device: { type: "string" } },
      required: ["device"],
    },
  },
  {
    name: "sim_shutdown",
    description: "Shut a simulator down.",
    inputSchema: {
      type: "object",
      properties: { device: { type: "string" } },
      required: ["device"],
    },
  },
  {
    name: "sim_screenshot",
    description:
      "PNG screenshot of a simulator screen (default: the booted one). Use it to check your UI change.",
    inputSchema: { type: "object", properties: { device: { type: "string" } } },
  },
  {
    name: "sim_open_url",
    description: "Open a URL or deep link in the simulator.",
    inputSchema: {
      type: "object",
      properties: { device: { type: "string" }, url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "sim_install",
    description:
      "Install a built .app bundle (path under the shared projects folder).",
    inputSchema: {
      type: "object",
      properties: { device: { type: "string" }, app_path: { type: "string" } },
      required: ["app_path"],
    },
  },
  {
    name: "sim_launch",
    description: "Launch (relaunch) an installed app by bundle id.",
    inputSchema: {
      type: "object",
      properties: { device: { type: "string" }, bundle_id: { type: "string" } },
      required: ["bundle_id"],
    },
  },
  {
    name: "sim_terminate",
    description: "Stop a running app by bundle id.",
    inputSchema: {
      type: "object",
      properties: { device: { type: "string" }, bundle_id: { type: "string" } },
      required: ["bundle_id"],
    },
  },
  {
    name: "sim_appearance",
    description: "Switch the simulator to light or dark mode.",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string" },
        mode: { type: "string", enum: ["light", "dark"] },
      },
      required: ["mode"],
    },
  },
  {
    name: "sim_logs",
    description:
      "Recent device logs (default last 60 s), optionally only one process (a Flutter app's process is 'Runner').",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string" },
        process: { type: "string" },
        seconds: { type: "number" },
      },
    },
  },
  {
    name: "sim_ui",
    description:
      "Drive the UI: action 'describe' (accessibility tree with frames), 'tap' (x,y in points), 'swipe' (x,y → x2,y2), 'type' (text). Needs AXe on the host.",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string" },
        action: { type: "string", enum: ["describe", "tap", "swipe", "type"] },
        x: { type: "number" },
        y: { type: "number" },
        x2: { type: "number" },
        y2: { type: "number" },
        text: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "flutter_run_ios",
    description:
      "Build a Flutter project for the iOS simulator on the Mac (flutter build ios --simulator --debug), install it and launch it. `project` is the app folder (container paths like /projects/app work). Takes minutes on the first build.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        device: { type: "string" },
        target: { type: "string", description: "e.g. lib/main_dev.dart" },
        flavor: { type: "string" },
        dart_defines: { type: "array", items: { type: "string" } },
      },
      required: ["project"],
    },
  },
  {
    name: "flutter_cmd",
    description:
      "Run flutter on the Mac host in a project folder: pub get, analyze, test (add `-d <udid>` with integration_test to run on the simulator), build, clean, gen-l10n, doctor, devices, format.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["args"],
    },
  },
];

function defaultRun(
  cmd,
  args,
  { cwd, timeout = 2 * MINUTE, encoding = "utf8" } = {},
) {
  return new Promise((resolveRun, reject) => {
    execFile(
      cmd,
      args,
      { cwd, timeout, encoding, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim();
          reject(new Error(`${cmd} ${args[0] ?? ""}: ${detail.slice(-3000)}`));
        } else resolveRun({ stdout, stderr });
      },
    );
  });
}

const text = (value) => ({ content: [{ type: "text", text: String(value) }] });
const tail = (value, max = 6000) => {
  const s = String(value ?? "").trim();
  return s.length > max ? `…${s.slice(-max)}` : s;
};

/** Tool handlers; `run` is injectable for tests. */
export function createSimHandlers({
  env = process.env,
  run = defaultRun,
} = {}) {
  const map = parsePathMap(env.SIM_MCP_PATH_MAP);
  const flutter = env.FLUTTER_BIN || "flutter";
  const axe = env.AXE_BIN || "axe";
  const simctl = (args, opts) => run("xcrun", ["simctl", ...args], opts);

  async function devices() {
    const { stdout } = await simctl(["list", "devices", "available", "-j"]);
    return parseDevices(stdout);
  }
  const device = async (wanted) => pickDevice(await devices(), wanted);

  async function appBundle(dir) {
    const out = join(dir, "build/ios/iphonesimulator");
    const app = existsSync(out)
      ? readdirSync(out).find((name) => name.endsWith(".app"))
      : null;
    if (!app) throw new Error(`no se encontró el .app en ${out}`);
    return join(out, app);
  }

  async function bundleId(appPath) {
    const { stdout } = await run("/usr/libexec/PlistBuddy", [
      "-c",
      "Print CFBundleIdentifier",
      join(appPath, "Info.plist"),
    ]);
    return stdout.trim();
  }

  return {
    async sim_list() {
      const list = await devices();
      return text(
        list
          .map(
            (d) =>
              `${d.state === "Booted" ? "●" : "○"} ${d.name} · ${d.os} · ${d.udid}`,
          )
          .join("\n") || "No hay simuladores.",
      );
    },
    async sim_boot({ device: wanted }) {
      const d = await device(wanted);
      if (d.state !== "Booted") await simctl(["boot", d.udid]);
      await run("open", [
        "-a",
        "Simulator",
        "--args",
        "-CurrentDeviceUDID",
        d.udid,
      ]).catch(() => null);
      await simctl(["bootstatus", d.udid, "-b"], { timeout: 3 * MINUTE }).catch(
        () => null,
      );
      return text(`${d.name} (${d.os}) encendido · ${d.udid}`);
    },
    async sim_shutdown({ device: wanted }) {
      const d = await device(wanted);
      if (d.state === "Booted") await simctl(["shutdown", d.udid]);
      return text(`${d.name} apagado`);
    },
    async sim_screenshot({ device: wanted } = {}) {
      const d = await device(wanted);
      const dir = mkdtempSync(join(tmpdir(), "sim-shot-"));
      try {
        const file = join(dir, "screen.png");
        await simctl(["io", d.udid, "screenshot", "--type=png", file]);
        // Keep the image small enough for the model's context.
        await run("sips", ["-Z", "1400", file]).catch(() => null);
        return {
          content: [
            {
              type: "image",
              data: readFileSync(file).toString("base64"),
              mimeType: "image/png",
            },
            { type: "text", text: `${d.name} (${d.os})` },
          ],
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async sim_open_url({ device: wanted, url }) {
      const d = await device(wanted);
      await simctl(["openurl", d.udid, String(url)]);
      return text(`Abierto ${url} en ${d.name}`);
    },
    async sim_install({ device: wanted, app_path }) {
      const d = await device(wanted);
      const app = hostPath(app_path, map);
      await simctl(["install", d.udid, app], { timeout: 5 * MINUTE });
      return text(`Instalado ${app} en ${d.name}`);
    },
    async sim_launch({ device: wanted, bundle_id }) {
      const d = await device(wanted);
      const { stdout } = await simctl([
        "launch",
        "--terminate-running-process",
        d.udid,
        String(bundle_id),
      ]);
      return text(stdout.trim() || `Lanzado ${bundle_id}`);
    },
    async sim_terminate({ device: wanted, bundle_id }) {
      const d = await device(wanted);
      await simctl(["terminate", d.udid, String(bundle_id)]);
      return text(`Detenido ${bundle_id}`);
    },
    async sim_appearance({ device: wanted, mode }) {
      if (!["light", "dark"].includes(mode))
        throw new Error("mode: light o dark");
      const d = await device(wanted);
      await simctl(["ui", d.udid, "appearance", mode]);
      return text(`${d.name} en modo ${mode}`);
    },
    async sim_logs({ device: wanted, process: proc, seconds = 60 } = {}) {
      const d = await device(wanted);
      const secs = Math.min(Math.max(Number(seconds) || 60, 5), 900);
      const args = [
        "spawn",
        d.udid,
        "log",
        "show",
        "--last",
        `${secs}s`,
        "--style",
        "compact",
      ];
      if (proc) {
        if (!/^[\w.-]+$/.test(proc))
          throw new Error("nombre de proceso no válido");
        args.push("--predicate", `process == "${proc}"`);
      }
      const { stdout } = await simctl(args, { timeout: 2 * MINUTE });
      return text(tail(stdout, 12_000) || "Sin logs en ese intervalo.");
    },
    async sim_ui({ device: wanted, action, x, y, x2, y2, text: input }) {
      const d = await device(wanted);
      const num = (v, name) => {
        if (!Number.isFinite(Number(v))) throw new Error(`falta ${name}`);
        return String(Math.round(Number(v)));
      };
      let args;
      if (action === "describe") args = ["describe-ui"];
      else if (action === "tap")
        args = ["tap", "-x", num(x, "x"), "-y", num(y, "y")];
      else if (action === "swipe")
        args = [
          "swipe",
          "--start-x",
          num(x, "x"),
          "--start-y",
          num(y, "y"),
          "--end-x",
          num(x2, "x2"),
          "--end-y",
          num(y2, "y2"),
        ];
      else if (action === "type") {
        if (!input) throw new Error("falta text");
        args = ["type", String(input)];
      } else throw new Error("action: describe, tap, swipe o type");
      try {
        const { stdout } = await run(axe, [...args, "--udid", d.udid]);
        return text(tail(stdout, 20_000) || "OK");
      } catch (error) {
        if (/ENOENT|not found/i.test(error.message))
          throw new Error(
            "AXe no está instalado en el Mac (brew install cameroncooke/axe/axe); mientras tanto usa sim_screenshot y sim_open_url",
          );
        throw error;
      }
    },
    async flutter_run_ios({
      project,
      device: wanted,
      target,
      flavor,
      dart_defines = [],
    }) {
      const dir = hostPath(project, map);
      const d = await device(wanted).catch(async () => {
        // Nothing booted: boot the newest iPhone.
        const iphones = (await devices()).filter((x) => /^iPhone/.test(x.name));
        if (!iphones.length) throw new Error("no hay simuladores de iPhone");
        const pick = pickDevice(iphones, iphones[0].name);
        await simctl(["boot", pick.udid]).catch(() => null);
        return pick;
      });
      const args = ["build", "ios", "--simulator", "--debug"];
      if (target) args.push("-t", String(target));
      if (flavor) args.push("--flavor", String(flavor));
      for (const define of dart_defines) args.push(`--dart-define=${define}`);
      const build = await run(flutter, args, {
        cwd: dir,
        timeout: 25 * MINUTE,
      });
      const app = await appBundle(dir);
      const id = await bundleId(app);
      await simctl(["install", d.udid, app], { timeout: 5 * MINUTE });
      await simctl(["launch", "--terminate-running-process", d.udid, id]);
      await run("open", ["-a", "Simulator"]).catch(() => null);
      return text(
        `App ${id} instalada y abierta en ${d.name} (${d.os}).\n${tail(build.stdout, 1500)}\nComprueba la pantalla con sim_screenshot.`,
      );
    },
    async flutter_cmd({ project, args }) {
      const list = flutterArgs(args);
      const cwd = project ? hostPath(project, map) : undefined;
      try {
        const { stdout, stderr } = await run(flutter, list, {
          cwd,
          timeout: 25 * MINUTE,
        });
        return text(tail(`${stdout}\n${stderr}`) || "OK");
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: tail(error.message) }],
        };
      }
    },
  };
}

/** Handles one JSON-RPC message; returns the response or null. */
export async function handleSimMessage(message, handlers) {
  const { id, method, params } = message ?? {};
  if (id === undefined || id === null) return null;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  if (method === "initialize")
    return reply({
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "simulator", version: "1" },
    });
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: SIM_TOOLS });
  if (method === "tools/call") {
    const handler = handlers[params?.name];
    if (!handler)
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `unknown tool ${params?.name}` },
      };
    try {
      return reply(await handler(params?.arguments ?? {}));
    } catch (error) {
      return reply({
        isError: true,
        content: [{ type: "text", text: error.message }],
      });
    }
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `method not found: ${method}` },
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const handlers = createSimHandlers();
  const inFlight = new Set();
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const task = handleSimMessage(message, handlers).then((response) => {
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      });
      inFlight.add(task);
      task.finally(() => inFlight.delete(task));
    }
  });
  process.stdin.on("end", async () => {
    await Promise.allSettled([...inFlight]);
    process.exit(0);
  });
}

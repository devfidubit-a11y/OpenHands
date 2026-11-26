// @ts-nocheck -- tests a plain-JS script: allowJs infers `= null` defaults as type null.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  SIM_TOOLS,
  createSimHandlers,
  flutterArgs,
  handleSimMessage,
  hostPath,
  parseDevices,
  parsePathMap,
  pickDevice,
  // @ts-expect-error -- plain ESM script without type declarations
} from "../../scripts/sim-mcp.mjs";

const SIMCTL_JSON = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
      { name: "iPhone 17", udid: "AAA", state: "Booted", isAvailable: true },
      { name: "iPhone 16", udid: "BBB", state: "Shutdown", isAvailable: true },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
      { name: "iPhone 17", udid: "CCC", state: "Shutdown", isAvailable: true },
      { name: "Old", udid: "DDD", state: "Shutdown", isAvailable: false },
    ],
  },
});

describe("sim-mcp helpers", () => {
  it("maps container paths to host paths and refuses others", () => {
    const map = parsePathMap("/projects=/Users/me/p, /documents=/Users/me/d");
    expect(hostPath("/projects/app", map)).toBe("/Users/me/p/app");
    expect(hostPath("/Users/me/d/x", map)).toBe("/Users/me/d/x");
    expect(() => hostPath("/etc/passwd", map)).toThrow(/fuera/);
    expect(() => hostPath("/projects/../etc", map)).toThrow(/fuera/);
    expect(hostPath("/anything", [])).toBe("/anything");
  });

  it("lists available devices and picks booted, by name or by udid", () => {
    const devices = parseDevices(SIMCTL_JSON);
    expect(devices.map((d) => d.udid)).toEqual(["AAA", "BBB", "CCC"]);
    expect(devices[0].os).toBe("iOS 26.5");
    expect(pickDevice(devices).udid).toBe("AAA");
    expect(pickDevice(devices, "ccc").udid).toBe("CCC");
    // same name twice: the booted one wins
    expect(pickDevice(devices, "iPhone 17").udid).toBe("AAA");
    const off = devices.map((d) => ({ ...d, state: "Shutdown" }));
    expect(pickDevice(off, "iPhone 17").udid).toBe("CCC"); // newest OS
    expect(() => pickDevice(off)).toThrow(/sim_boot/);
    expect(() => pickDevice(devices, "Pixel")).toThrow(/no existe/);
  });

  it("allows only non-interactive flutter subcommands", () => {
    expect(flutterArgs(["test", "-d", "AAA"])).toEqual(["test", "-d", "AAA"]);
    expect(flutterArgs("pub get")).toEqual(["pub", "get"]);
    expect(() => flutterArgs(["run"])).toThrow(/flutter_run_ios/);
    expect(() => flutterArgs([])).toThrow();
  });
});

describe("sim-mcp handlers", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function fakeRun(log: string[][]) {
    return async (cmd: string, args: string[]) => {
      log.push([cmd, ...args]);
      if (args[1] === "list") return { stdout: SIMCTL_JSON, stderr: "" };
      if (cmd.endsWith("PlistBuddy"))
        return { stdout: "com.example.app\n", stderr: "" };
      if (args[1] === "io") {
        writeFileSync(args[args.length - 1], Buffer.from("png"));
        return { stdout: "", stderr: "" };
      }
      return { stdout: "ok", stderr: "" };
    };
  }

  it("builds, installs and launches a Flutter app from a container path", async () => {
    const host = mkdtempSync(join(tmpdir(), "sim-host-"));
    dirs.push(host);
    mkdirSync(join(host, "app/build/ios/iphonesimulator/Runner.app"), {
      recursive: true,
    });
    const log: string[][] = [];
    const handlers = createSimHandlers({
      env: { SIM_MCP_PATH_MAP: `/projects=${host}`, FLUTTER_BIN: "flutter" },
      run: fakeRun(log),
    });
    const result = await handlers.flutter_run_ios({
      project: "/projects/app",
      flavor: "dev",
    });
    expect(result.content[0].text).toContain("com.example.app");
    const flat = log.map((entry) => entry.join(" "));
    expect(flat).toContain(
      "flutter build ios --simulator --debug --flavor dev",
    );
    expect(
      flat.some(
        (line) =>
          line.includes("simctl install AAA") && line.includes("Runner.app"),
      ),
    ).toBe(true);
    expect(flat).toContain(
      "xcrun simctl launch --terminate-running-process AAA com.example.app",
    );
  });

  it("returns a screenshot as image content", async () => {
    const handlers = createSimHandlers({ env: {}, run: fakeRun([]) });
    const shot = await handlers.sim_screenshot({});
    expect(shot.content[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(Buffer.from(shot.content[0].data, "base64").toString()).toBe("png");
  });

  it("explains how to get AXe when it is missing", async () => {
    const handlers = createSimHandlers({
      env: {},
      run: async (cmd: string, args: string[]) => {
        if (cmd === "axe") throw new Error("spawn axe ENOENT");
        return fakeRun([])(cmd, args);
      },
    });
    await expect(
      handlers.sim_ui({ action: "tap", x: 10, y: 20 }),
    ).rejects.toThrow(/brew install/);
  });

  it("speaks MCP: initialize, tools/list, tools/call errors", async () => {
    const handlers = createSimHandlers({ env: {}, run: fakeRun([]) });
    const init = await handleSimMessage(
      { id: 1, method: "initialize", params: {} },
      handlers,
    );
    expect(init.result.serverInfo.name).toBe("simulator");
    const list = await handleSimMessage(
      { id: 2, method: "tools/list" },
      handlers,
    );
    expect(list.result.tools).toBe(SIM_TOOLS);
    const bad = await handleSimMessage(
      {
        id: 3,
        method: "tools/call",
        params: { name: "sim_appearance", arguments: { mode: "blue" } },
      },
      handlers,
    );
    expect(bad.result.isError).toBe(true);
    expect(
      await handleSimMessage({ method: "notifications/initialized" }, handlers),
    ).toBeNull();
  });
});

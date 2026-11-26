---
name: ios-simulator
description: "Run and check apps on the iPhone/iPad simulators of the Mac host through the `simulator` MCP: list and boot simulators, build and launch Flutter apps (flutter_run_ios), install .app bundles, take screenshots, read logs, open deep links, switch dark mode, and tap/swipe/type. Use to verify a mobile UI change visually, reproduce a bug on iOS, or run integration tests on a simulator."
---

# iOS simulator (on the Mac host)

The agents run in a Linux container without Xcode, so the simulators are
reached through the `simulator` MCP, which runs on the Mac. Paths you pass
can be container paths under `/projects` or `/documents`; the MCP maps them
to the Mac. If the MCP isn't available, say so and stop: don't try to install
Xcode or a simulator in the container.

## Workflow

1. `sim_list`: pick a device. Prefer a booted one (●); otherwise the device
   the user named, else a current iPhone (for example "iPhone 17").
2. `sim_boot` it (it opens the Simulator app so the user can watch).
3. Build and open the app:
   - Flutter: `flutter_run_ios` with `project` (and `target`, `flavor`,
     `dart_defines` when the app needs them). The first build takes minutes.
   - Native/other: build the `.app` for the simulator, then `sim_install`
     and `sim_launch` with its bundle id.
4. Check it: `sim_screenshot` after each important step; look at the image
   and compare with the request or the design. Check dark mode with
   `sim_appearance` and deep links with `sim_open_url`.
5. Interact when needed: `sim_ui` `describe` gives the accessibility tree
   with frames (in points); `tap`/`swipe` use those coordinates and `type`
   enters text. It needs AXe on the Mac; without it, say that taps are not
   available and continue with screenshots and deep links.
6. Errors: `sim_logs` with `process: "Runner"` (Flutter) or the app's
   process name, `seconds` 60–300.

## Rules

- Several agents may share a simulator: don't erase or reset devices, and
  don't shut down a simulator you didn't boot unless the user asks.
- Don't change the host's Xcode, simulators or certificates; report signing
  or pod problems with the exact error and the fix you suggest.
- Report what you saw (attach what the screenshot showed in words) and what
  you could not check.

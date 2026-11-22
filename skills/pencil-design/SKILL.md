---
name: pencil-design
description: "Design with pen.dev (Pencil) through its MCP server: read, create and edit .pen design files, pull styles and tokens, take screenshots, and turn designs into code or code into designs. Use for frontend and UX work whenever a .pen file exists or the user mentions pen.dev, Pencil, a .pen design, a mockup, or designing screens before coding."
---

# Pencil (pen.dev) design

The `pencil` MCP server gives agents the Pen app's tools: `get_app_state`,
`read_skill`, `get_style`, `execute`, `browser`, and `save`. It runs on the
user's Mac next to the Pen app and is reached through a gateway, so it works
only while the Pen app is open.

## Rules

- **.pen files are encrypted.** Never read, grep, cat, or edit them as text.
  Use only the `pencil` MCP tools.
- **Host paths.** You see `/documents/...` and `/projects/...`, but the Pen
  app runs on the host. Before passing a path to a Pencil tool, translate it:
  `/documents/...` → `$PEN_HOST_DOCUMENTS_DIR/...` and `/projects/...` →
  `$PEN_HOST_PROJECTS_DIR/...` (`echo $PEN_HOST_DOCUMENTS_DIR`). Paths that
  come back from Pencil are host paths: translate them back before you open
  them with your own tools.
- Start with `get_app_state` to see which files and selection are open, then
  `read_skill` for the guide that fits the task (design, code generation,
  styles). Follow the tool input schemas exactly.
- **Saving changes the user's design file.** Before `save` on an existing
  file, say what you changed. For a big redesign, work on a copy or a new
  page, and keep the original (change-safety-guard).
- If the tools are missing or fail with a connection error, the Pen app or
  the gateway is not running. Say so in your report and continue without
  Pencil. Never try to start or install anything on the host.

## Workflows

**Design → code (frontend):**

1. `get_app_state`, then read the frame or component the task names.
2. `get_style` for colors, typography, spacing and radii. Map them to the
   project's design tokens (Tailwind config, CSS variables). Don't hard-code
   values that already exist as tokens.
3. Build the components with senior-frontend and component-design-patterns:
   responsive, accessible, every state the design shows (hover, focus,
   empty, loading, error).
4. Compare: render the page (qa-testing visual check) and the Pencil frame
   side by side. List the differences that remain.

**Code or idea → design (UX/UI):**

1. Read the current screens in the code, or the brief.
2. Create or update frames in a .pen file with `execute`, using the
   project's tokens. Follow ux-design, ui-design and ux-ui-storytelling.
3. Show the result with a screenshot, explain the choices, and `save` only
   with the user's agreement when the file already existed.

**Review a design:** check hierarchy, contrast (WCAG AA), spacing rhythm,
consistency with the tokens, copy, and missing states. Report each issue
with the frame name and a fix.

## Report

The file and frames you used, what you created or changed (saved or not),
the tokens you mapped, and remaining differences between design and code.

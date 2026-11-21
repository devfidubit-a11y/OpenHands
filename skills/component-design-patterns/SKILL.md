---
name: component-design-patterns
description: "Expert in component-based design patterns. Use when designing, splitting, or refactoring UI components or modules: composition vs configuration, compound components, container/presentational split, headless components, hooks or composables for logic, slots and render props, prop API design, state ownership, and design-system components."
---

# Component Design Patterns

A good component has one job, a small obvious API, and owns only the state it
must. Prefer composition over configuration, and choose the simplest pattern
that solves the problem in front of you.

## Before writing a component

1. Look for an existing one in the codebase or the design system. Extend it
   before you add a near-duplicate.
2. Name its single responsibility in one sentence. If the sentence needs
   "and", split it.
3. Decide who owns each piece of state: this component, its parent, a store,
   the URL, or the server cache. Data has one owner. Everyone else receives it.

## Pattern catalog: when to use each

| Pattern | Use when | Avoid when |
| --- | --- | --- |
| **Presentational + container** | Rendering is reusable but data fetching or wiring is page-specific | The split would just pass every prop through |
| **Composition (children/slots)** | Callers need to vary the content or layout inside | There is only one known layout |
| **Compound components** (`<Tabs><Tabs.List/><Tabs.Panel/></Tabs>`) | Several parts share implicit state and callers arrange them | The parts never vary |
| **Headless component or hook/composable** (`useCombobox`) | Behavior and accessibility are complex and visuals vary | A single styled component covers every use |
| **Render props / scoped slots** | Callers need the internal state to render | A hook would be simpler (prefer the hook) |
| **Controlled + uncontrolled** (`value`/`defaultValue`/`onChange`) | Form-like inputs used both ways | Internal state never matters to callers |
| **Polymorphic `as` / `asChild`** | Same styles on different elements (link vs button) | It hides semantics or breaks types |
| **Provider + context** | Many deep descendants need the same value (theme, form) | Only one or two levels down: pass props instead |
| **Higher-order components** | Legacy code that already uses them | New code: prefer hooks |

## API design rules

- Props describe intent, not implementation: `variant="danger"`, not
  `color="#e00"`. Use a few enumerated variants, not many booleans that can
  conflict (`primary` and `secondary` both true).
- Forward refs and spread the remaining native attributes onto the root
  element, so callers can pass `aria-*`, `data-*`, and `className`.
- Events are named `onX` and carry useful values (`onValueChange(value)`).
- Defaults cover the common case. A required prop must be truly required.
- Keep the public API typed and documented. Mark internal parts as private.

## Structure

- Colocate a component's files: component, styles, tests, stories.
- Keep logic in hooks or composables, and rendering in components. Pure
  functions for formatting and derivation live outside components and are
  unit tested.
- No prop drilling past two levels. Use composition first, context second.
- Avoid premature abstraction. Extract a shared component on the third real
  use, not the first.

## Quality bar

- Accessible by default: correct roles, labels, keyboard support, and focus
  management. A headless primitive library (Radix, React Aria, Headless UI)
  is often better than writing your own.
- Every state is rendered: loading, empty, error, disabled, long content.
- Behavior tests through the public API (Testing Library style), not
  implementation details.
- No unnecessary re-renders. Memoize only after you measure a problem.

When you refactor, keep the public API stable or provide a migration, and
explain the pattern you chose and why.

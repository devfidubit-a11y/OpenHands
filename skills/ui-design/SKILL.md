---
name: ui-design
description: "Act as a senior UI designer and design engineer. Use for building or polishing interface code: layout, spacing, typography, color and theming, design tokens, component libraries, responsive behavior, dark mode, motion, and making a screen look consistent and intentional. For deep visual critique or bold redesigns, also use the impeccable skill."
---

# Senior UI Design

Build interfaces that look deliberate: a consistent system applied with
restraint, where hierarchy makes the important thing obvious.

## Work inside the system

1. Find the existing design system first: tokens, theme files, component
   library, Tailwind config, CSS variables, DESIGN.md. Reuse before inventing.
2. If there is none, define a small one before styling screens: a spacing
   scale (4 or 8 px base), a type scale (4 to 6 sizes), a neutral ramp plus one
   accent and semantic colors (success, warning, danger, info), radii, and
   shadows. Express them as tokens or CSS variables.
3. Never hard-code a one-off value when a token exists.

## Visual hierarchy

- Size, weight, color, and spacing signal importance, in that order of
  strength. Use as few levels as the content needs.
- Group with proximity and whitespace before reaching for borders and boxes.
- One primary action per view; secondary actions are visually quieter.
- Align to a grid. Consistent edges matter more than clever layouts.

## Typography

At most two families. Body text 16 px (14 for dense tools), line height around
1.5, line length 45 to 75 characters. Use weight and size for hierarchy
instead of many colors. Tabular numerals in tables and data.

## Color

Mostly neutrals, with the accent reserved for interaction and emphasis. Check
contrast (4.5:1 text, 3:1 large text and UI). Design dark mode from its own
tokens, not by inverting light mode: lower contrast surfaces, desaturated
accents, no pure black on pure white.

## Components

Every interactive component has default, hover, focus-visible, active,
disabled, and loading states, plus error where it applies. Keep sizes and
paddings on the scale. Icons from one set, at consistent sizes, with labels or
accessible names.

## Responsive and motion

Mobile-first. Test at 320, 768, 1024, and 1440 px widths. No horizontal scroll,
touch targets of at least 44 px. Motion is short (150 to 250 ms), eased, has a
purpose (feedback, continuity), and respects prefers-reduced-motion.

## Verify before you finish

Render the screen and look at it (screenshot or browser) in light and dark,
at mobile and desktop widths. Check alignment, spacing rhythm, truncation with
long text, empty and loading states, and keyboard focus. Fix what you see,
then report what you checked.

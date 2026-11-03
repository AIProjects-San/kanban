/**
 * Design tokens — TypeScript mirror of src/styles/tokens.css.
 *
 * Why both? CSS custom properties can't be read at render time without a
 * layout-thrashing getComputedStyle() round trip, and a few components need
 * a color VALUE inline (accent swatches in settings, avatar pickers). Those
 * import from here; everything else uses the CSS classes/tokens directly.
 *
 * ⚠ KEEP IN SYNC: tokens-sync.test.ts parses tokens.css and compares the
 * `--avatar-*` / tag / priority values against this file, so the two can
 * never drift silently. Change a color in BOTH (or just the CSS + test will
 * fail until the TS side matches).
 *
 * Rule: components must NOT hardcode oklch()/hex literals — import from
 * here (JS context) or use the `f-*` classes / Tailwind token utilities
 * (CSS context). See docs/CODING_STANDARDS.md.
 */

/**
 * Avatar palette (CSS: `--avatar-*`, tokens.css §7). Keys match the
 * `avatarColor` values used by the Avatar component and seed data.
 */
export const AVATAR_COLORS = {
  // PR-39 (a11y): darkened alongside tokens.css §7 so white avatar initials
  // clear WCAG AA 4.5:1 (measured 6.8-8.4:1). Keep in sync with tokens.css.
  forest: "oklch(0.45 0.12 152)",
  ocean: "oklch(0.45 0.12 220)",
  plum: "oklch(0.45 0.13 320)",
  ember: "oklch(0.47 0.13 35)",
  slate: "oklch(0.42 0.02 250)",
} as const;

export type AvatarColorKey = keyof typeof AVATAR_COLORS;

/**
 * Tag palette foreground anchors (CSS: `--tag-*-fg`, tokens.css §5) — the
 * light-theme text colors, used for legends/charts that sit on card
 * backgrounds. Background variants are CSS-only.
 */
export const TAG_FG_COLORS = {
  frontend: "oklch(0.45 0.16 220)",
  backend: "oklch(0.43 0.18 280)",
  design: "oklch(0.50 0.18 320)",
  qa: "oklch(0.47 0.17 30)",
  marketing: "oklch(0.45 0.16 160)",
} as const;

/**
 * Priority palette foreground anchors (CSS: `--priority-*-fg`, §6) —
 * light-theme text colors for charts/legends.
 */
export const PRIORITY_FG_COLORS = {
  high: "oklch(0.45 0.23 27)",
  medium: "oklch(0.50 0.16 70)",
  low: "oklch(0.42 0.16 152)",
} as const;

/**
 * The design tokens of `03-architecture/08-ux-design-system.md` §1, as data.
 *
 * `styles/tokens.css` is the runtime source of truth — Tailwind reads it and the
 * browser paints from it. This module exists so tests, the `ui-kit` review page
 * and any code that has to reason about a colour (a canvas overlay, a generated
 * OpenGraph image) can name the same value instead of re-typing a hex string.
 * `tokens.test.ts` asserts the two stay in step.
 */

/** Near-black surfaces. The studio is dark-only in v1 (08 §1). */
export const SURFACE = {
  bg0: "#0B0B0E",
  bg1: "#131318",
  bg2: "#1B1B22",
  border: "#2A2A33",
  overlay: "rgba(0, 0, 0, 0.6)",
} as const;

export const TEXT = {
  fg0: "#F5F5F7",
  fg1: "#C9C9D1",
  fg2: "#8B8B96",
  disabled: "#5C5C66",
} as const;

/** Lime, so a screenshot is never mistaken for a competitor's (08 §1). */
export const ACCENT = {
  lime500: "#D8FF3D",
  lime600: "#B9E020",
  onAccent: "#0B0B0E",
} as const;

/** Proposal and job states. Also the palette `StatusChip` maps onto. */
export const SIGNAL = {
  proposed: "#FFB020",
  accepted: "#38D39F",
  rejected: "#FF5C5C",
  info: "#4EA1FF",
  warning: "#FF8A3D",
} as const;

/** Caption defaults; the editor's canvas and the style previews start here. */
export const CAPTION = {
  fill: "#FFFFFF",
  highlight: "#FFD400",
  stroke: "#000000",
} as const;

export const RADIUS = { sm: "8px", md: "12px", lg: "16px" } as const;

/** 4 px grid. */
export const SPACE_UNIT_PX = 4;

/** UI motion only: caption animation is content, not chrome (08 §1). */
export const MOTION = {
  fast: "120ms",
  base: "160ms",
  slow: "200ms",
  ease: "cubic-bezier(0.22, 1, 0.36, 1)",
} as const;

export const TOKENS = {
  surface: SURFACE,
  text: TEXT,
  accent: ACCENT,
  signal: SIGNAL,
  caption: CAPTION,
  radius: RADIUS,
  motion: MOTION,
} as const;

export type Tokens = typeof TOKENS;

/** The signal a `StatusChip` or a `ProposalCard` paints itself with. */
export type SignalTone = keyof typeof SIGNAL;

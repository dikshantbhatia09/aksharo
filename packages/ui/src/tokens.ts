/**
 * The design tokens of `03-architecture/08-ux-design-system.md` §1, as data.
 *
 * `styles/tokens.css` is the runtime source of truth — Tailwind reads it and the
 * browser paints from it. This module exists so tests, the `ui-kit` review page
 * and any code that has to reason about a colour (a canvas overlay, a generated
 * OpenGraph image) can name the same value instead of re-typing a hex string.
 * `tokens.test.ts` asserts the two stay in step.
 */

/** Near-black surfaces — Kalakar's own zinc ramp (pixel-sampled 2026-09-12), not a blue-tinted navy one. */
export const SURFACE = {
  bg0: "#0d0d0d",
  bg1: "#18181b",
  bg2: "#27272a",
  bg3: "#3f3f46",
  border: "#303034",
  borderHover: "#45454d",
  overlay: "rgb(0 0 0 / 0.7)",
} as const;

export const TEXT = {
  fg0: "#e9e9ed",
  fg1: "#d4d4d8",
  fg2: "#a1a1aa",
  disabled: "#71717a",
} as const;

/** Brand Accents: Mint & Gold (08 §1). */
export const ACCENT = {
  lime500: "#49a781",
  lime600: "#57b88f",
  onAccent: "#08120e",
} as const;

/** Proposal and job states. Also the palette `StatusChip` maps onto. */
export const SIGNAL = {
  proposed: "#f59e0b",
  accepted: "#22c55e",
  rejected: "#ef4444",
  info: "#3b82f6",
  warning: "#f59e0b",
} as const;

/** Caption defaults; the editor's canvas and the style previews start here. */
export const CAPTION = {
  fill: "#ffffff",
  highlight: "#f59e0b",
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

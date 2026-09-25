/**
 * The Shirorekha design tokens, as data (spec: `docs/redesign/DESIGN.md`).
 *
 * `styles/tokens.css` is the runtime source of truth — Tailwind reads it and the
 * browser paints from it. This module exists so tests, the `ui-kit` review page
 * and any code that has to reason about a colour (a canvas overlay, a generated
 * OpenGraph image) can name the same value instead of re-typing a hex string.
 * `tokens.test.ts` asserts the two stay in step.
 */

/**
 * Warm charcoal grounds: the page, a lighter surface for cards and panels, a
 * sunken well for rails and timelines, and one near-black `ink` reserved for the
 * video canvas.
 */
export const SURFACE = {
  bg0: "#141217",
  bg1: "#1f1c23",
  bg2: "#2a262f",
  bg3: "#38333d",
  border: "#36313a",
  borderHover: "#4a4450",
  overlay: "rgb(11 10 12 / 0.72)",
  surface: "#1f1c23",
  sunken: "#0e0c10",
  ink: "#0b0a0c",
} as const;

export const TEXT = {
  fg0: "#f1ece6",
  fg1: "#d6cfc8",
  fg2: "#a39a93",
  disabled: "#7c746e",
} as const;

/**
 * One accent: rani pink, #f0508a. `lime500`/`lime600` are historical names kept
 * because 80-odd files consume the CSS variables they back. `lime600` is the
 * *lighter* step, because on a dark ground a hover moves toward the light end.
 */
export const ACCENT = {
  lime500: "#f0508a",
  lime600: "#f36b9b",
  onAccent: "#141217",
} as const;

/**
 * The accent's 100–900 tonal ramp, stepped to roughly the same lightness
 * scale as {@link NEUTRAL}.
 */
export const ACCENT_RAMP = {
  100: "#fde8f0",
  200: "#fbcadd",
  300: "#f78bb0",
  400: "#f36b9b",
  500: "#f0508a",
  600: "#c8336c",
  700: "#962752",
  800: "#5e1d37",
  900: "#2e1420",
} as const;

/** The neutral 100–900 ramp: surfaces, borders and muted text. */
export const NEUTRAL = {
  100: "#f7f3ef",
  200: "#ebe5df",
  300: "#d6cfc8",
  400: "#bcb3ac",
  500: "#a39a93",
  600: "#7c746e",
  700: "#5a534f",
  800: "#3d3739",
  900: "#262227",
} as const;

/** Proposal and job states. Also the palette `StatusChip` maps onto. */
export const SIGNAL = {
  proposed: "#e8b04a",
  accepted: "#6fcf97",
  rejected: "#ef7d4f",
  info: "#7fa6f5",
  warning: "#e8b04a",
} as const;

/**
 * Caption defaults; the editor's canvas and the style previews start here.
 *
 * Deliberately outside the chrome palette: these burn into exported video
 * over arbitrary footage, so they are chosen for legibility, not for the app's
 * chrome. Never use the brand accent as a caption colour.
 */
export const CAPTION = {
  fill: "#ffffff",
  highlight: "#ffd400",
  stroke: "#000000",
} as const;

export const RADIUS = { sm: "6px", md: "10px", lg: "16px" } as const;

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
  accentRamp: ACCENT_RAMP,
  neutral: NEUTRAL,
  signal: SIGNAL,
  caption: CAPTION,
  radius: RADIUS,
  motion: MOTION,
} as const;

export type Tokens = typeof TOKENS;

/** The signal a `StatusChip` or a `ProposalCard` paints itself with. */
export type SignalTone = keyof typeof SIGNAL;

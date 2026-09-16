/**
 * The Nocturne design tokens, as data.
 *
 * `styles/tokens.css` is the runtime source of truth — Tailwind reads it and the
 * browser paints from it. This module exists so tests, the `ui-kit` review page
 * and any code that has to reason about a colour (a canvas overlay, a generated
 * OpenGraph image) can name the same value instead of re-typing a hex string.
 * `tokens.test.ts` asserts the two stay in step.
 */

/**
 * Nocturne's grounds: a near-neutral blue-grey page, a lighter surface for
 * cards and panels, a sunken well for rails and timelines, and one near-black
 * `ink` reserved for the video canvas.
 */
export const SURFACE = {
  bg0: "#161826",
  bg1: "#232532",
  bg2: "#2c2f3e",
  bg3: "#3a3d4f",
  border: "#383946",
  borderHover: "#4a4c5c",
  overlay: "rgb(10 11 18 / 0.72)",
  surface: "#232532",
  sunken: "#101220",
  ink: "#0a0b12",
} as const;

export const TEXT = {
  fg0: "#e9e9ed",
  fg1: "#cfd3e5",
  fg2: "#9397ab",
  disabled: "#75798c",
} as const;

/**
 * One accent: Nocturne's blurple, #9184d9. `lime500`/`lime600` are historical
 * names kept because 80-odd files consume the CSS variables they back; there
 * is no lime in this palette. `lime600` is the *lighter* step, because on a
 * dark ground a hover moves one step toward the light end of the ramp.
 */
export const ACCENT = {
  lime500: "#9184d9",
  lime600: "#b5abfc",
  onAccent: "#0a0b12",
} as const;

/**
 * The accent's 100–900 tonal ramp, generated in OKLCH on the same perceptual
 * lightness scale as {@link NEUTRAL}, so the same step of either matches in
 * visual weight.
 */
export const ACCENT_RAMP = {
  100: "#f5f4ff",
  200: "#e7e5fe",
  300: "#d2cefd",
  400: "#b5abfc",
  500: "#968ae0",
  600: "#796cbf",
  700: "#5d5294",
  800: "#423a6a",
  900: "#2b2741",
} as const;

/** The neutral 100–900 ramp: surfaces, borders and muted text. */
export const NEUTRAL = {
  100: "#f3f5fe",
  200: "#e4e7f5",
  300: "#cfd3e5",
  400: "#b2b6ca",
  500: "#9397ab",
  600: "#75798c",
  700: "#595d6c",
  800: "#3f424d",
  900: "#292b31",
} as const;

/** Proposal and job states. Also the palette `StatusChip` maps onto. */
export const SIGNAL = {
  proposed: "#e6b45c",
  accepted: "#6dc99e",
  rejected: "#e8776f",
  info: "#7aa2f7",
  warning: "#e6b45c",
} as const;

/**
 * Caption defaults; the editor's canvas and the style previews start here.
 *
 * Deliberately outside the Nocturne palette: these burn into exported video
 * over arbitrary footage, so they are chosen for legibility, not for the app's
 * chrome. Never use the brand accent as a caption colour.
 */
export const CAPTION = {
  fill: "#ffffff",
  highlight: "#ffd400",
  stroke: "#000000",
} as const;

export const RADIUS = { sm: "8px", md: "12px", lg: "14px" } as const;

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

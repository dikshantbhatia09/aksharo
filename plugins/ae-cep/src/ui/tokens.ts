/**
 * A minimal copy of the values in `packages/ui/src/tokens.ts` — same copy
 * `plugins/premiere-uxp/src/ui/tokens.ts` (C05a) keeps, for the identical reason: this panel
 * does not depend on `@montaj/ui` (Radix + Tailwind + a PostCSS build this plugin's
 * esbuild-IIFE bundle isn't set up to run). Deviation flagged in the WP report.
 */
export const SURFACE = {
  bg0: "#0B0B0E",
  bg1: "#131318",
  bg2: "#1B1B22",
  border: "#2A2A33",
} as const;
export const TEXT = {
  fg0: "#F5F5F7",
  fg1: "#C9C9D1",
  fg2: "#8B8B96",
  disabled: "#5C5C66",
} as const;
export const ACCENT = { lime500: "#D8FF3D", lime600: "#B9E020", onAccent: "#0B0B0E" } as const;
export const SIGNAL = {
  proposed: "#FFB020",
  accepted: "#38D39F",
  rejected: "#FF5C5C",
  info: "#4EA1FF",
} as const;
export const FONT_FAMILY = "'Inter', system-ui, -apple-system, sans-serif";

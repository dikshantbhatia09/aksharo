/**
 * A minimal copy of the values in `packages/ui/src/tokens.ts` (`03-architecture/08-ux-design-
 * system.md` §1), same reasoning as `plugins/premiere-uxp/src/ui/tokens.ts`: this panel's
 * esbuild-IIFE bundle does not pull in `@montaj/ui`'s Radix + Tailwind + PostCSS pipeline.
 * Deviation flagged in the WP report, same as C05a's.
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

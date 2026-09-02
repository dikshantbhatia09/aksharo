/** Test-only StyleDoc fixture builder — not part of the public surface. */
import type { StyleDoc } from "@montaj/caption-styles";

export function makeStyle(overrides: Partial<StyleDoc> = {}): StyleDoc {
  const base: StyleDoc = {
    id: "test-style",
    name: "Test Style",
    version: 2,
    category: "clean",
    minPlan: "free",
    typography: {
      fontFamily: "Inter",
      weight: 700,
      italic: false,
      sizePct: 6,
      lineHeight: 1.2,
      letterSpacingEm: 0,
      textTransform: "none",
    },
    colors: { text: "#ffffff" },
    box: { enabled: false, mode: "block", paddingPct: 10, radiusPct: 10, opacity: 1 },
    stroke: { enabled: false, widthPct: 0 },
    shadow: { enabled: false, offsetXPct: 0, offsetYPct: 0, blurPct: 0, opacity: 0 },
    layout: {
      anchor: "bottom-center",
      x: 0.5,
      y: 0.8,
      align: "center",
      maxWidthPct: 84,
      maxLines: 2,
    },
    animation: {
      in: { type: "fade", durationMs: 100 },
      out: { type: "fade", durationMs: 100 },
      wordHighlight: { type: "none", durationMs: 0 },
      perWord: false,
    },
    emphasisPresets: [],
    assRenderable: false,
    assExportable: false,
    requiresLayoutMetrics: true,
  };
  return { ...base, ...overrides };
}

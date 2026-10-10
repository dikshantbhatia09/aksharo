/**
 * Popular Viral Caption Style Presets Engine (Pillar 4 §06).
 *
 * Implements gold-standard design presets pioneered by top viral creators:
 * - Hormozi Neon Pop (bold uppercase, neon yellow/lime highlight, heavy stroke, spring bounce)
 * - MrBeast Comic (chunky comic display, multi-color palette rotation, dynamic comic tilt)
 * - Karaoke Cyan (progressive wipe reveal muted -> vivid mint/cyan)
 * - Editorial Ghost (sophisticated minimalist typography for thought leadership)
 * - Neon Cyber Pulse (glowing neon aura with intense text shadow and futuristic display fonts)
 */

import { z } from "zod";

import {
  type StyleDoc,
  type StyleCategory,
  STYLE_DOC_VERSION,
} from "./schema.js";

/** Hex color string (#RRGGBB or #RRGGBBAA) or rgba string */
export const ColorFormatSchema = z.string().regex(
  /^(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\))$/,
  "expected valid hex or rgba color",
);

export const ViralPresetKeySchema = z.enum([
  "hormozi_neon",
  "editorial_ghost",
  "karaoke_cyan",
  "mrbeast_comic",
  "neon_pulse",
]);

export type ViralPresetKey = z.infer<typeof ViralPresetKeySchema>;

export const ViralPresetItemSchema = z.object({
  name: z.string().min(2).max(64),
  fontFamily: z.string().min(1).max(120),
  fontSize: z.number().gt(0).max(120),
  textTransform: z.enum(["none", "uppercase", "lowercase", "capitalize"]),
  colorInactive: ColorFormatSchema,
  colorActive: ColorFormatSchema,
  strokeColor: ColorFormatSchema.optional(),
  strokeWidth: z.number().min(0).max(30).optional(),
  shadowColor: ColorFormatSchema.optional(),
  shadowOffset: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .optional(),
  backgroundPill: z
    .object({
      color: ColorFormatSchema,
      padding: z.object({ x: z.number().min(0), y: z.number().min(0) }),
      borderRadius: z.number().min(0),
    })
    .optional(),
  animation: z.string().min(1),
  maxWordsPerScreen: z.number().int().min(1).max(20),
});

export type ViralPresetItem = z.infer<typeof ViralPresetItemSchema>;

export const ViralPresetCatalogueSchema = z.record(
  ViralPresetKeySchema,
  ViralPresetItemSchema,
);

export type ViralPresetCatalogue = z.infer<typeof ViralPresetCatalogueSchema>;

/** Declarative specifications of core viral caption presets */
export const BUILTIN_PRESETS = {
  hormozi_neon: {
    name: "Hormozi Neon Pop",
    fontFamily: "The Bold Font",
    fontSize: 56,
    textTransform: "uppercase",
    colorInactive: "#FFFFFF",
    colorActive: "#FEE715", // Neon Yellow
    strokeColor: "#000000",
    strokeWidth: 10,
    shadowColor: "rgba(0,0,0,0.8)",
    shadowOffset: { x: 0, y: 6 },
    animation: "POP_BOUNCE",
    maxWordsPerScreen: 3,
  },
  editorial_ghost: {
    name: "Editorial Ghost",
    fontFamily: "Cabinet Grotesk",
    fontSize: 44,
    textTransform: "none",
    colorInactive: "rgba(255,255,255,0.45)",
    colorActive: "#FFFFFF",
    strokeWidth: 0,
    backgroundPill: {
      color: "rgba(0,0,0,0.6)",
      padding: { x: 16, y: 8 },
      borderRadius: 12,
    },
    animation: "PROGRESSIVE_FADE",
    maxWordsPerScreen: 6,
  },
  karaoke_cyan: {
    name: "Karaoke Cyan",
    fontFamily: "Montserrat",
    fontSize: 50,
    textTransform: "uppercase",
    colorInactive: "#8E8E93",
    colorActive: "#00FFA3", // Vivid Mint / Cyan
    strokeColor: "#000000",
    strokeWidth: 6,
    animation: "KARAOKE_FILL",
    maxWordsPerScreen: 5,
  },
  mrbeast_comic: {
    name: "MrBeast Comic",
    fontFamily: "Komika Axis",
    fontSize: 54,
    textTransform: "uppercase",
    colorInactive: "#FFFFFF",
    colorActive: "#00E5FF",
    strokeColor: "#000000",
    strokeWidth: 8,
    shadowColor: "rgba(0,0,0,0.9)",
    shadowOffset: { x: 0, y: 5 },
    animation: "COMIC_TILT",
    maxWordsPerScreen: 4,
  },
  neon_pulse: {
    name: "Neon Cyber Pulse",
    fontFamily: "Orbitron",
    fontSize: 48,
    textTransform: "uppercase",
    colorInactive: "#EAFBFF",
    colorActive: "#00F0FF",
    strokeColor: "#0A1F27",
    strokeWidth: 4,
    shadowColor: "#00F0FF",
    shadowOffset: { x: 0, y: 0 },
    animation: "NEON_GLOW",
    maxWordsPerScreen: 4,
  },
} as const satisfies Record<ViralPresetKey, ViralPresetItem>;

/** Mapping from viral preset keys to corresponding system styles */
export const VIRAL_PRESET_TO_SYSTEM_STYLE: Readonly<Record<ViralPresetKey, string>> = {
  hormozi_neon: "punch-pop",
  editorial_ghost: "editorial-ghost-type",
  karaoke_cyan: "karaoke-fill",
  mrbeast_comic: "hype-bold",
  neon_pulse: "neon-glow",
};

/** Compliant look names adhering to the D64 style naming rule */
export const VIRAL_PRESET_COMPLIANT_NAMES: Readonly<Record<ViralPresetKey, string>> = {
  hormozi_neon: "Punch Pop",
  editorial_ghost: "Ghost Type",
  karaoke_cyan: "Karaoke Fill",
  mrbeast_comic: "Hype Bold",
  neon_pulse: "Neon Glow",
};

/** Reverse mapping from system style ID to viral preset key */
export const SYSTEM_STYLE_TO_VIRAL_PRESET: Readonly<Record<string, ViralPresetKey>> = {
  "punch-pop": "hormozi_neon",
  "editorial-ghost-type": "editorial_ghost",
  "karaoke-fill": "karaoke_cyan",
  "hype-bold": "mrbeast_comic",
  "neon-glow": "neon_pulse",
};

/** Recommended bundled fallbacks for viral display fonts */
export const VIRAL_FONT_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  "The Bold Font": ["Inter", "Bebas Neue", "Anton", "Noto Sans Devanagari", "Noto Sans Tamil", "Noto Sans"],
  "Cabinet Grotesk": ["Playfair Display", "DM Sans", "Inter", "Noto Sans Devanagari", "Noto Sans Tamil", "Noto Sans"],
  "Montserrat": ["Poppins", "Inter", "Noto Sans Devanagari", "Noto Sans Tamil", "Noto Sans"],
  "Komika Axis": ["Bangers", "Bungee", "Poppins", "Noto Sans Devanagari", "Noto Sans Tamil", "Noto Sans"],
  "Orbitron": ["Montserrat", "Inter", "Roboto Mono", "Noto Sans Devanagari", "Noto Sans Tamil", "Noto Sans"],
};

/** Normalize color to 6-hex or 8-hex string for StyleDoc compliance */
function normalizeHexColor(color: string, fallback = "#000000"): string {
  if (color.startsWith("#")) {
    if (color.length === 7 || color.length === 9) return color.toLowerCase();
    if (color.length === 4) {
      const r = color[1];
      const g = color[2];
      const b = color[3];
      return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
  }
  const rgbaMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(color);
  if (rgbaMatch) {
    const r = Math.min(255, Math.max(0, parseInt(rgbaMatch[1] ?? "0", 10))).toString(16).padStart(2, "0");
    const g = Math.min(255, Math.max(0, parseInt(rgbaMatch[2] ?? "0", 10))).toString(16).padStart(2, "0");
    const b = Math.min(255, Math.max(0, parseInt(rgbaMatch[3] ?? "0", 10))).toString(16).padStart(2, "0");
    const alphaNum = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1.0;
    const a = Math.round(Math.min(1, Math.max(0, alphaNum)) * 255).toString(16).padStart(2, "0");
    return `#${r}${g}${b}${a}`.toLowerCase();
  }
  return fallback;
}

export interface CompilePresetOptions {
  /** When true (default), formats id & name to pass the D64 creator-brand deny-list rule */
  readonly compliantNaming?: boolean;
  /** Canvas height used to convert pixel fontSize to canvas percentage (default 1080 or 1920) */
  readonly canvasHeight?: number;
}

/**
 * Compiles a declarative ViralPreset into a production-ready StyleDoc Schema JSON.
 */
export function compilePresetToStyleDoc(
  keyOrPreset: ViralPresetKey | ViralPresetItem,
  options: CompilePresetOptions = {},
): StyleDoc {
  const compliant = options.compliantNaming ?? true;
  const canvasHeight = options.canvasHeight ?? 1080;

  let key: ViralPresetKey;
  let preset: ViralPresetItem;

  if (typeof keyOrPreset === "string") {
    key = keyOrPreset;
    preset = BUILTIN_PRESETS[key];
  } else {
    // Attempt reverse lookup by name
    const foundEntry = (Object.entries(BUILTIN_PRESETS) as [ViralPresetKey, ViralPresetItem][]).find(
      ([, item]) => item.name === keyOrPreset.name || item.fontFamily === keyOrPreset.fontFamily,
    );
    key = foundEntry ? foundEntry[0] : "hormozi_neon";
    preset = keyOrPreset;
  }

  const id = compliant
    ? VIRAL_PRESET_TO_SYSTEM_STYLE[key]
    : key.replace(/_/g, "-");
  const name = compliant
    ? VIRAL_PRESET_COMPLIANT_NAMES[key]
    : preset.name;

  const sizePct = Number(((preset.fontSize / canvasHeight) * 100).toFixed(2));
  const primaryColor = normalizeHexColor(preset.colorInactive, "#ffffff");
  const activeColor = normalizeHexColor(preset.colorActive, "#fee715");
  const strokeColor = preset.strokeColor ? normalizeHexColor(preset.strokeColor, "#000000") : "#000000";
  const shadowColor = preset.shadowColor ? normalizeHexColor(preset.shadowColor, "#000000") : "#000000";

  const fallbacks = [...(VIRAL_FONT_FALLBACKS[preset.fontFamily] ?? ["Noto Sans Devanagari", "Noto Sans Tamil", "Noto Sans"])];

  const category: StyleCategory =
    key === "karaoke_cyan"
      ? "karaoke"
      : key === "editorial_ghost"
        ? "kinetic"
        : "bold";

  return {
    id,
    name,
    version: STYLE_DOC_VERSION,
    category,
    minPlan: "free",
    typography: {
      fontFamily: preset.fontFamily,
      fallbacks,
      weight: key === "editorial_ghost" ? 600 : 800,
      italic: false,
      sizePct,
      lineHeight: 1.15,
      letterSpacingEm: -0.01,
      textTransform: preset.textTransform,
      scriptScale: {
        deva: 0.82,
        taml: 0.44,
      },
    },
    colors: {
      text: primaryColor,
      activeText: activeColor,
      upcomingText: primaryColor,
      accent: activeColor,
      highlightAccents: [activeColor, "#00e5ff", "#00ff66", "#ff007f"],
    },
    box: {
      enabled: preset.backgroundPill !== undefined,
      mode: preset.backgroundPill ? "block" : "line",
      fill: preset.backgroundPill ? normalizeHexColor(preset.backgroundPill.color, "#101018") : "#101018",
      paddingPct: preset.backgroundPill ? preset.backgroundPill.padding.x * 2 : 18,
      radiusPct: preset.backgroundPill ? preset.backgroundPill.borderRadius : 20,
      opacity: preset.backgroundPill ? 0.75 : 0.6,
    },
    stroke: {
      enabled: (preset.strokeWidth ?? 0) > 0,
      color: strokeColor,
      widthPct: preset.strokeWidth ?? 0,
    },
    shadow: {
      enabled: preset.shadowColor !== undefined,
      color: shadowColor,
      offsetXPct: preset.shadowOffset?.x ?? 0,
      offsetYPct: preset.shadowOffset?.y ?? 4,
      blurPct: key === "neon_pulse" ? 40 : 10,
      opacity: 0.8,
    },
    layout: {
      anchor: "bottom-center",
      x: 0.5,
      y: 0.7188,
      align: "center",
      maxWidthPct: 81.48,
      maxLines: 2,
      wordsPerCue: preset.maxWordsPerScreen,
      safeAreaPct: 12,
    },
    animation: {
      in: {
        type: key === "editorial_ghost" ? "fade" : key === "karaoke_cyan" ? "slide-up" : "pop",
        durationMs: 140,
      },
      out: {
        type: "fade",
        durationMs: 120,
      },
      wordHighlight: {
        type: key === "karaoke_cyan" ? "karaoke-fill" : key === "neon_pulse" ? "glow" : "scale",
        durationMs: 120,
        scale: 1.18,
      },
      perWord: false,
    },
    emphasisPresets: [
      {
        id: "pop",
        label: "Pop",
        color: activeColor,
        scale: 1.2,
        effect: "none",
      },
      {
        id: "highlight",
        label: "Highlight",
        color: activeColor,
        effect: key === "neon_pulse" ? "glow" : "highlight",
      },
    ],
    assRenderable: false,
    assExportable: true,
    requiresLayoutMetrics: true,
  };
}

import { z } from "zod";

import { findNamingViolations } from "./naming.js";

/**
 * StyleDoc v2 — the caption style document (07 §Caption style schema, F-305).
 *
 * A style describes a *look*, never a person, creator or brand (D64): the naming
 * rule is part of the schema, so a document that breaks it cannot be parsed.
 *
 * Sizes are percentages of the **canvas height**, not pixels, so one document
 * renders identically at 1080×1920 and at 540×960; lengths that belong to the
 * type (stroke width, shadow offset and blur, box padding and radius) are
 * percentages of the **font size** for the same reason.
 */

/** Kebab-case, the id used in `styleRef` and in `styles/<id>.json`. */
export const StyleIdSchema = z
  .string()
  .min(3)
  .max(48)
  .regex(
    // eslint-disable-next-line security/detect-unsafe-regex -- reviewed and timed against adversarial input -- linear, no nested unbounded quantifiers -- not exponential (see M06 report)
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "style ids are kebab-case: lowercase words joined by single hyphens",
  );

/** `#RRGGBB` or `#RRGGBBAA`. */
export const ColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "expected #RRGGBB or #RRGGBBAA");

/** Catalogue shelf the style sits on. */
export const StyleCategorySchema = z.enum([
  "bold",
  "clean",
  "karaoke",
  "podcast",
  "gaming",
  "education",
  "cinematic",
  "playful",
  "minimal",
  "retro",
]);

/** Lowest plan that may use the style (04 §Plans). */
export const MinPlanSchema = z.enum(["free", "starter", "creator", "studio", "agency"]);

/** Entry and exit animations `render-core` implements; A16 extends the list. */
export const CueAnimationTypeSchema = z.enum([
  "none",
  "fade",
  "pop",
  "slide-up",
  "slide-down",
  "typewriter",
  "bounce",
  "blur",
]);

/** How the word being spoken is marked. */
export const WordHighlightTypeSchema = z.enum([
  "none",
  "color",
  "scale",
  "box",
  "underline",
  "karaoke-fill",
  "glow",
]);

/**
 * Per-script multipliers on `sizePct`, keyed by the lowercase OpenType script
 * tag (`latn`, `deva`, `taml`, …). Absent, or an absent key, means 1.
 *
 * It exists because the segmenter's line budgets are counted in **base
 * characters** — combining marks are excluded, because they occupy no width of
 * their own in the reading-speed sense (`09 §3`). Width is a different
 * question: a 22-character Tamil line is around 37 code points and roughly
 * twice as wide as 32 characters of Latin. Without a per-script multiplier the
 * only way to make a full-budget Indic line fit is to shrink every style for
 * every script, which turns a creator caption into a subtitle. This keeps Latin
 * at the size the style was drawn for and lets Indic take the size it needs.
 *
 * `render-core` multiplies the type size by the entry for the script it is
 * actually laying out — the script of the words on screen, not the project's
 * language, so a Hinglish caption picks the right one line by line.
 */
export const ScriptScaleSchema = z
  .record(
    z
      .string()
      .regex(/^[a-z]{4}$/, "script keys are lowercase four-letter OpenType tags, e.g. deva"),
    z.number().gt(0).max(2),
  )
  .describe("per-script multiplier on sizePct, keyed by lowercase OpenType script tag");

export const TypographySchema = z.object({
  /** Family name; must resolve to a bundled or workspace font (A18b). */
  fontFamily: z.string().min(1).max(120),
  /** Subset font id when the family is a workspace upload. */
  fontId: z.string().min(1).max(64).optional(),
  /** Families tried for glyphs the main family lacks, e.g. Devanagari. */
  fallbacks: z.array(z.string().min(1).max(120)).max(6).optional(),
  weight: z.number().int().min(100).max(900),
  italic: z.boolean(),
  /** Font size as a percentage of canvas height. */
  sizePct: z.number().gt(0).max(40),
  /** Multiple of the font size. */
  lineHeight: z.number().min(0.6).max(3),
  /** Tracking, in em. */
  letterSpacingEm: z.number().min(-0.5).max(1),
  textTransform: z.enum(["none", "uppercase", "lowercase", "capitalize"]),
  /**
   * Optional per-script size multipliers. Additive in StyleDoc v2: a document
   * without it renders exactly as before, so no migration is needed.
   */
  scriptScale: ScriptScaleSchema.optional(),
  /**
   * A quick-format underline, independent of the word-highlight `underline`
   * type and of an emphasis preset's own `underline` effect: those two mark
   * one word at a time, this marks the caption's type itself, the whole time
   * it is on screen (K01). Additive in StyleDoc v2 — omitted means `false`,
   * so every document written before this field renders exactly as before.
   */
  underline: z.boolean().optional(),
});

export const ColorsSchema = z.object({
  /** Resting colour of every word. */
  text: ColorSchema,
  /** The word being spoken, when `animation.wordHighlight` colours it. */
  activeText: ColorSchema.optional(),
  /** Words not yet spoken, for read-ahead styles. */
  upcomingText: ColorSchema.optional(),
  /** Colour used by emphasis presets and by the karaoke fill. */
  accent: ColorSchema.optional(),
});

export const BoxSchema = z.object({
  enabled: z.boolean(),
  /** What the box wraps: the whole cue, one line, or one word. */
  mode: z.enum(["block", "line", "word"]),
  fill: ColorSchema.optional(),
  /** Percentage of the font size. */
  paddingPct: z.number().min(0).max(200),
  /** Percentage of the box height; 50 is a pill. */
  radiusPct: z.number().min(0).max(50),
  opacity: z.number().min(0).max(1),
});

export const StrokeSchema = z.object({
  enabled: z.boolean(),
  color: ColorSchema.optional(),
  /** Percentage of the font size. */
  widthPct: z.number().min(0).max(30),
});

export const ShadowSchema = z.object({
  enabled: z.boolean(),
  color: ColorSchema.optional(),
  /** Percentages of the font size. */
  offsetXPct: z.number().min(-50).max(50),
  offsetYPct: z.number().min(-50).max(50),
  blurPct: z.number().min(0).max(100),
  opacity: z.number().min(0).max(1),
});

/**
 * The classic faux-3D-extrusion effect (K01): a small stack of offset copies
 * of the caption's type, stepping diagonally from `offsetPct` and tinted with
 * `color`, drawn behind the main glyph run. Absent entirely on every style
 * written before this field — StyleDoc v2 stays generation 2, no migration.
 */
export const Depth3dSchema = z.object({
  enabled: z.boolean(),
  color: ColorSchema,
  /** Percentage of the font size each layer steps diagonally by. */
  offsetPct: z.number().min(0).max(30),
  /** Copies drawn behind the type; capped for perf (a frame draws this every time). */
  layers: z.number().int().min(1).max(8).optional(),
});

export const LayoutSchema = z.object({
  /** Box corner the position addresses. */
  anchor: z.enum([
    "top-left",
    "top-center",
    "top-right",
    "middle-left",
    "center",
    "middle-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
  ]),
  /** Normalised canvas position of the anchor. */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  align: z.enum(["left", "center", "right"]),
  /** Percentage of canvas width the cue may occupy. */
  maxWidthPct: z.number().gt(0).max(100),
  maxLines: z.number().int().min(1).max(4),
  /** Words shown at once; omitted means "as many as fit". */
  wordsPerCue: z.number().int().min(1).max(20).optional(),
  /** Margin kept clear of platform chrome, percentage of canvas height. */
  safeAreaPct: z.number().min(0).max(40).optional(),
});

export const CueAnimationSchema = z.object({
  type: CueAnimationTypeSchema,
  durationMs: z.number().int().min(0).max(2_000),
});

export const WordHighlightSchema = z.object({
  type: WordHighlightTypeSchema,
  durationMs: z.number().int().min(0).max(2_000),
  /** Scale applied by `scale` highlights, 1 = no growth. */
  scale: z.number().min(0.5).max(2).optional(),
});

export const AnimationSchema = z.object({
  in: CueAnimationSchema,
  out: CueAnimationSchema,
  wordHighlight: WordHighlightSchema,
  /** One word on screen at a time (word-pop styles). */
  perWord: z.boolean(),
});

/**
 * Named emphasis a user can apply to a single word; `Segment.emphasis[].presetId`
 * in `@montaj/edg` points here.
 */
export const EmphasisPresetSchema = z.object({
  id: z
    .string()
    .min(2)
    .max(32)
    // eslint-disable-next-line security/detect-unsafe-regex -- reviewed and timed against adversarial input -- linear, no nested unbounded quantifiers -- not exponential (see M06 report)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "emphasis preset ids are kebab-case"),
  label: z.string().min(1).max(48).optional(),
  color: ColorSchema.optional(),
  /** Multiplier on the word's size. */
  scale: z.number().min(0.5).max(2.5).optional(),
  weight: z.number().int().min(100).max(900).optional(),
  effect: z.enum(["none", "glow", "shake", "outline", "highlight", "underline"]).optional(),
});

/** The StyleDoc schema generation, exactly as `EdgHot.meta.schemaVersion` gates the EDG. */
export const STYLE_DOC_VERSION = 2;

export const StyleDocSchema = z
  .object({
    id: StyleIdSchema,
    /** Display name; validated against the same deny-list as the id (D64). */
    name: z.string().min(2).max(48),
    /** StyleDoc schema generation; bumped only by a migration. */
    version: z.literal(STYLE_DOC_VERSION),
    category: StyleCategorySchema,
    minPlan: MinPlanSchema,
    typography: TypographySchema,
    colors: ColorsSchema,
    box: BoxSchema,
    stroke: StrokeSchema,
    shadow: ShadowSchema,
    /**
     * Faux-3D text extrusion (K01). Additive and optional: absent means
     * disabled, exactly like a style drawn before this field existed.
     */
    depth3d: Depth3dSchema.optional(),
    layout: LayoutSchema,
    animation: AnimationSchema,
    emphasisPresets: z.array(EmphasisPresetSchema).max(12),
    /**
     * Parity flags, written by the A18a parity gate in CI and never by hand
     * (D33). The defaults are the conservative pre-gate answer: assume a style
     * needs `render-core` until an SSIM diff proves libass matches it.
     */
    assRenderable: z.boolean().default(false),
    assExportable: z.boolean().default(false),
    requiresLayoutMetrics: z.boolean().default(true),
    /** Fraction of pixels within tolerance on the golden set; written by CI. */
    parityScore: z.number().min(0).max(1).optional(),
    /** R2 key of the preview clip (CONTRACTS §6). */
    previewKey: z.string().min(1).max(256).optional(),
  })
  .check((ctx) => {
    for (const violation of findNamingViolations(ctx.value)) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value[violation.field],
        path: [violation.field],
        message: `${violation.field} contains the disallowed token "${violation.token}" — styles describe the look, never a person, creator or brand (D64)`,
      });
    }
  });

export type StyleId = z.infer<typeof StyleIdSchema>;
export type StyleCategory = z.infer<typeof StyleCategorySchema>;
export type MinPlan = z.infer<typeof MinPlanSchema>;
export type ScriptScale = z.infer<typeof ScriptScaleSchema>;
export type Typography = z.infer<typeof TypographySchema>;
export type Colors = z.infer<typeof ColorsSchema>;
export type Box = z.infer<typeof BoxSchema>;
export type Stroke = z.infer<typeof StrokeSchema>;
export type Shadow = z.infer<typeof ShadowSchema>;
export type Depth3d = z.infer<typeof Depth3dSchema>;
export type Layout = z.infer<typeof LayoutSchema>;
export type CueAnimationType = z.infer<typeof CueAnimationTypeSchema>;
export type CueAnimation = z.infer<typeof CueAnimationSchema>;
export type WordHighlightType = z.infer<typeof WordHighlightTypeSchema>;
export type WordHighlight = z.infer<typeof WordHighlightSchema>;
export type Animation = z.infer<typeof AnimationSchema>;
export type EmphasisPreset = z.infer<typeof EmphasisPresetSchema>;

/** A validated style document, with the parity flags filled in. */
export type StyleDoc = z.infer<typeof StyleDocSchema>;

/** What an author writes: the parity flags may be omitted. */
export type StyleDocInput = z.input<typeof StyleDocSchema>;

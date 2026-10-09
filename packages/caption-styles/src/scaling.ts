import type { StyleDoc } from "./schema.js";

/**
 * Multi-Aspect Ratio Dynamic Typography Scaling Engine (Pillar 3 §06 §2.1 & §5 Step 2).
 *
 * Calculates proportional font size, line height, max cue width, and safe-zone
 * vertical positioning offset (`yOffset`) across 9:16, 1:1, 4:5, and 16:9 canvases
 * so captions remain legible and never collide with bottom letterboxes or
 * platform feed UI overlays (Reels, LinkedIn Square, Instagram 4:5, YouTube 16:9).
 */

export const CAPTION_ASPECT_RATIOS = ["9:16", "1:1", "4:5", "16:9"] as const;
export type CaptionAspectRatio = (typeof CAPTION_ASPECT_RATIOS)[number];

/**
 * Base caption font sizes in pixels on a standard 1080p-class reference canvas
 * per aspect ratio (Pillar 3 §06 §2.1):
 * - 9:16 Canvas (1080×1920): 54 px
 * - 4:5 Canvas (1080×1350): 48 px
 * - 1:1 Canvas (1080×1080): 42 px
 * - 16:9 Canvas (1920×1080): 44 px
 */
export const ASPECT_BASE_FONT_SIZE_PX: Readonly<Record<CaptionAspectRatio, number>> =
  Object.freeze({
    "9:16": 54,
    "4:5": 48,
    "1:1": 42,
    "16:9": 44,
  });

export const ASPECT_REFERENCE_CANVAS: Readonly<
  Record<CaptionAspectRatio, { readonly width: number; readonly height: number }>
> = Object.freeze({
  "9:16": Object.freeze({ width: 1080, height: 1920 }),
  "4:5": Object.freeze({ width: 1080, height: 1350 }),
  "1:1": Object.freeze({ width: 1080, height: 1080 }),
  "16:9": Object.freeze({ width: 1920, height: 1080 }),
});

export interface AspectSafeZoneRule {
  readonly baseFontSizePx: number;
  readonly lineHeight: number;
  /** Minimum bottom safe-zone margin (% of canvas height) to clear platform UI chrome. */
  readonly safeBottomPct: number;
  /** Minimum top safe-zone margin (% of canvas height). */
  readonly safeTopPct: number;
  /** Default normalized Y anchor (0 = top, 1 = bottom). */
  readonly defaultYNormalized: number;
  /** Maximum horizontal width (% of canvas width) for caption wrapping. */
  readonly maxWidthPct: number;
}

export const ASPECT_SAFE_ZONE_RULES: Readonly<Record<CaptionAspectRatio, AspectSafeZoneRule>> =
  Object.freeze({
    "9:16": Object.freeze({
      baseFontSizePx: 54,
      lineHeight: 1.22,
      safeBottomPct: 18,
      safeTopPct: 12,
      defaultYNormalized: 0.78,
      maxWidthPct: 84,
    }),
    "4:5": Object.freeze({
      baseFontSizePx: 48,
      lineHeight: 1.2,
      safeBottomPct: 15,
      safeTopPct: 10,
      defaultYNormalized: 0.8,
      maxWidthPct: 86,
    }),
    "1:1": Object.freeze({
      baseFontSizePx: 42,
      lineHeight: 1.18,
      safeBottomPct: 14,
      safeTopPct: 10,
      defaultYNormalized: 0.82,
      maxWidthPct: 88,
    }),
    "16:9": Object.freeze({
      baseFontSizePx: 44,
      lineHeight: 1.16,
      safeBottomPct: 12,
      safeTopPct: 8,
      defaultYNormalized: 0.85,
      maxWidthPct: 78,
    }),
  });

export interface AspectTypographyScalingInput {
  /** Target aspect ratio; inferred from `canvasWidth / canvasHeight` when omitted. */
  readonly aspect?: CaptionAspectRatio;
  /** Target canvas width in pixels (defaults to reference width for `aspect`). */
  readonly canvasWidth?: number;
  /** Target canvas height in pixels (defaults to reference height for `aspect`). */
  readonly canvasHeight?: number;
  /** Optional custom 9:16 base font size in px (defaults to 54px and scales per aspect). */
  readonly reference9x16FontSizePx?: number;
  /** Optional custom line-height multiplier override. */
  readonly baseLineHeight?: number;
  /** Optional requested normalized vertical anchor (0..1). */
  readonly requestedYNormalized?: number;
  /** Height of bottom letterbox bar in pixels, if any, to keep captions clear of letterboxes. */
  readonly letterboxBottomPx?: number;
}

export interface AspectTypographyScaling {
  readonly aspect: CaptionAspectRatio;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly widthScale: number;
  readonly baseFontSizePx: number;
  readonly fontSizePx: number;
  /** Font size expressed as a percentage of `canvasHeight` (`StyleDoc.typography.sizePct`). */
  readonly sizePct: number;
  readonly lineHeight: number;
  readonly lineHeightPx: number;
  /** Vertical offset in pixels measured up from the bottom edge of the canvas (`canvasHeight - captionY`). */
  readonly yOffset: number;
  /** Vertical pixel coordinate measured down from the top edge of the canvas. */
  readonly captionY: number;
  /** Clamped normalized vertical coordinate in `[0, 1]`. */
  readonly yNormalized: number;
  readonly safeTopPx: number;
  readonly safeBottomPx: number;
  readonly safeAreaPct: number;
  readonly maxWidthPct: number;
  readonly maxWidthPx: number;
}

/**
 * Infer the closest supported `CaptionAspectRatio` (`9:16`, `4:5`, `1:1`, `16:9`)
 * from arbitrary positive canvas dimensions.
 */
export function inferCaptionAspectRatio(width: number, height: number): CaptionAspectRatio {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "9:16";
  }
  const ratio = width / height;
  const candidates: ReadonlyArray<{ readonly aspect: CaptionAspectRatio; readonly ratio: number }> =
    [
      { aspect: "9:16", ratio: 9 / 16 },
      { aspect: "4:5", ratio: 4 / 5 },
      { aspect: "1:1", ratio: 1 },
      { aspect: "16:9", ratio: 16 / 9 },
    ];
  let best: CaptionAspectRatio = "9:16";
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const diff = Math.abs(ratio - candidate.ratio);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate.aspect;
    }
  }
  return best;
}

/**
 * Compute proportional font size, line height, and safe-zone vertical positioning
 * (`yOffset` and `yNormalized`) for a target aspect ratio and canvas dimensions.
 */
export function computeAspectTypographyScaling(
  input: AspectTypographyScalingInput = {},
): AspectTypographyScaling {
  const aspect: CaptionAspectRatio =
    input.aspect ??
    (input.canvasWidth !== undefined && input.canvasHeight !== undefined
      ? inferCaptionAspectRatio(input.canvasWidth, input.canvasHeight)
      : "9:16");

  // eslint-disable-next-line security/detect-object-injection -- closed enum key
  const reference = ASPECT_REFERENCE_CANVAS[aspect];
  // eslint-disable-next-line security/detect-object-injection -- closed enum key
  const rule = ASPECT_SAFE_ZONE_RULES[aspect];

  const canvasWidth =
    typeof input.canvasWidth === "number" &&
    Number.isFinite(input.canvasWidth) &&
    input.canvasWidth > 0
      ? Math.round(input.canvasWidth)
      : reference.width;
  const canvasHeight =
    typeof input.canvasHeight === "number" &&
    Number.isFinite(input.canvasHeight) &&
    input.canvasHeight > 0
      ? Math.round(input.canvasHeight)
      : reference.height;

  const widthScale = canvasWidth / reference.width;
  const customFactor =
    typeof input.reference9x16FontSizePx === "number" &&
    Number.isFinite(input.reference9x16FontSizePx) &&
    input.reference9x16FontSizePx > 0
      ? input.reference9x16FontSizePx / ASPECT_BASE_FONT_SIZE_PX["9:16"]
      : 1;

  const baseFontSizePx = Math.round(rule.baseFontSizePx * customFactor);
  const fontSizePx = Math.max(12, Math.round(baseFontSizePx * widthScale));
  const sizePct = Number(Math.min(40, Math.max(0.5, (fontSizePx / canvasHeight) * 100)).toFixed(4));

  const lineHeight =
    typeof input.baseLineHeight === "number" &&
    Number.isFinite(input.baseLineHeight) &&
    input.baseLineHeight >= 0.6 &&
    input.baseLineHeight <= 3
      ? Number((input.baseLineHeight * (rule.lineHeight / 1.22)).toFixed(3))
      : rule.lineHeight;
  const lineHeightPx = Math.max(14, Math.round(fontSizePx * lineHeight));

  const safeTopPx = Math.round((rule.safeTopPct / 100) * canvasHeight);
  const platformSafeBottomPx = Math.round((rule.safeBottomPct / 100) * canvasHeight);
  const letterboxBottomPx =
    typeof input.letterboxBottomPx === "number" &&
    Number.isFinite(input.letterboxBottomPx) &&
    input.letterboxBottomPx > 0
      ? Math.round(input.letterboxBottomPx)
      : 0;
  const letterboxClearancePx =
    letterboxBottomPx > 0 ? letterboxBottomPx + Math.round(lineHeightPx * 0.75) : 0;
  const safeBottomPx = Math.max(platformSafeBottomPx, letterboxClearancePx);

  const rawYNormalized =
    typeof input.requestedYNormalized === "number" && Number.isFinite(input.requestedYNormalized)
      ? input.requestedYNormalized
      : rule.defaultYNormalized;

  const minY = safeTopPx;
  const maxY = Math.max(minY, canvasHeight - safeBottomPx);
  const unclampedCaptionY = Math.round(rawYNormalized * canvasHeight);
  const captionY = Math.min(maxY, Math.max(minY, unclampedCaptionY));
  const yOffset = Math.max(0, canvasHeight - captionY);
  const yNormalized = Number((captionY / canvasHeight).toFixed(4));
  const safeAreaPct = Number(
    Math.min(40, Math.max(rule.safeBottomPct, (safeBottomPx / canvasHeight) * 100)).toFixed(2),
  );
  const maxWidthPct = rule.maxWidthPct;
  const maxWidthPx = Math.round((maxWidthPct / 100) * canvasWidth);

  return {
    aspect,
    canvasWidth,
    canvasHeight,
    widthScale: Number(widthScale.toFixed(4)),
    baseFontSizePx,
    fontSizePx,
    sizePct,
    lineHeight,
    lineHeightPx,
    yOffset,
    captionY,
    yNormalized,
    safeTopPx,
    safeBottomPx,
    safeAreaPct,
    maxWidthPct,
    maxWidthPx,
  };
}

/**
 * Adapt a `StyleDoc` for a target aspect ratio (`9:16`, `1:1`, `4:5`, `16:9`),
 * re-scaling `typography.sizePct`, `typography.lineHeight`, `layout.y`,
 * `layout.maxWidthPct`, and `layout.safeAreaPct`.
 */
export function scaleStyleDocForAspect(
  style: StyleDoc,
  aspect: CaptionAspectRatio,
  canvas?: { readonly width: number; readonly height: number },
  options?: { readonly letterboxBottomPx?: number },
): StyleDoc {
  // Derive the style's 9:16 equivalent pixel size on a 1920-tall canvas
  const ref9x16FontPx = (style.typography.sizePct / 100) * ASPECT_REFERENCE_CANVAS["9:16"].height;
  const scaling = computeAspectTypographyScaling({
    aspect,
    ...(canvas === undefined
      ? {}
      : { canvasWidth: canvas.width, canvasHeight: canvas.height }),
    reference9x16FontSizePx: ref9x16FontPx,
    baseLineHeight: style.typography.lineHeight,
    requestedYNormalized: style.layout.y,
    ...(options?.letterboxBottomPx === undefined
      ? {}
      : { letterboxBottomPx: options.letterboxBottomPx }),
  });

  return {
    ...style,
    typography: {
      ...style.typography,
      sizePct: scaling.sizePct,
      lineHeight: scaling.lineHeight,
    },
    layout: {
      ...style.layout,
      y: scaling.yNormalized,
      maxWidthPct: Math.min(style.layout.maxWidthPct, scaling.maxWidthPct),
      safeAreaPct: scaling.safeAreaPct,
    },
  };
}

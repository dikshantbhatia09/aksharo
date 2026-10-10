import type { StyleDoc } from "./schema.js";

/**
 * Social Media Safe-Zone & UI Avoidance Engine (Pillar 3 §08).
 *
 * Implements strict, pixel-precise bounding boxes representing active UI layouts
 * of TikTok, Instagram Reels, YouTube Shorts, and Universal 9:16 video on a
 * 1080×1920 canvas.
 *
 * Universal Safe Zone:
 * - Top Exclusion: 0 - 160 px (Search, Nav tabs, Status bar)
 * - Bottom Exclusion: 1480 - 1920 px (440 px: Username, Description, Audio ticker, Nav bar)
 * - Right Exclusion: 950 - 1080 px (130 px: Like, Comment, Bookmark, Share action buttons)
 * - Left Exclusion: 0 - 50 px (Screen edge margin)
 *
 * Safe bounds: X ∈ [50, 950], Y ∈ [160, 1480].
 * Safe subtitle width: max 880 px centered at X = 540 px.
 * Default caption baseline: Y = 1380 px (normalized 0.7188 on 1920 canvas).
 */

export type SafeZonePlatform = "tiktok" | "reels" | "shorts" | "universal";

export interface SafeZoneSpec {
  readonly topMarginPx: number;
  readonly bottomMarginPx: number;
  readonly rightMarginPx: number;
  readonly leftMarginPx: number;
  readonly defaultCaptionY: number; // Baseline Y on 1920 canvas
}

export const PLATFORM_SAFE_ZONES: Readonly<Record<SafeZonePlatform, SafeZoneSpec>> =
  Object.freeze({
    tiktok: Object.freeze({
      topMarginPx: 160,
      bottomMarginPx: 440,
      rightMarginPx: 130,
      leftMarginPx: 50,
      defaultCaptionY: 1380,
    }),
    reels: Object.freeze({
      topMarginPx: 140,
      bottomMarginPx: 380,
      rightMarginPx: 110,
      leftMarginPx: 50,
      defaultCaptionY: 1400,
    }),
    shorts: Object.freeze({
      topMarginPx: 120,
      bottomMarginPx: 340,
      rightMarginPx: 120,
      leftMarginPx: 50,
      defaultCaptionY: 1420,
    }),
    universal: Object.freeze({
      topMarginPx: 160,
      bottomMarginPx: 440,
      rightMarginPx: 130,
      leftMarginPx: 50,
      defaultCaptionY: 1380,
    }),
  });

/** Reference canvas dimensions (9:16 vertical master). */
export const REFERENCE_CANVAS = Object.freeze({
  width: 1080,
  height: 1920,
});

/** Default caption baseline Y coordinate on a 1920-tall canvas (comfortably above TikTok's 1480px text baseline). */
export const DEFAULT_BOTTOM_CAPTION_Y = 1380;

/** Default normalized vertical position for bottom captions (1380 / 1920). */
export const DEFAULT_BOTTOM_Y_NORMALIZED = 0.7188;

/** Maximum bounding box width in pixels on a 1080 canvas to clear right-side action buttons. */
export const MAX_SAFE_CAPTION_WIDTH_PX = 880;

/** Maximum bounding box width as a percentage of 1080 canvas width (880 / 1080 * 100). */
export const MAX_SAFE_CAPTION_WIDTH_PCT = 81.48;

/** Maximum safe baseline Y before captions risk entering the bottom exclusion zone. */
export const MAX_BOTTOM_BASELINE_Y_PX = 1420;

/** Maximum safe baseline Y normalized on a 1920 canvas (1420 / 1920). */
export const MAX_BOTTOM_BASELINE_Y_NORMALIZED = 0.7396;

/** Magnetic snap threshold: dragging below Y = 1440 px triggers snap back to safe zone. */
export const SNAP_BOTTOM_Y_THRESHOLD_PX = 1440;

/** Magnetic snap normalized threshold (1440 / 1920 = 0.75). */
export const SNAP_BOTTOM_Y_THRESHOLD_NORMALIZED = 0.75;

export interface SafeZoneBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
  readonly defaultCaptionY: number;
  readonly maxBaselineY: number;
}

export interface PlatformExclusions {
  readonly top: readonly [number, number, number, number];
  readonly bottom: readonly [number, number, number, number];
  readonly right: readonly [number, number, number, number];
  readonly left: readonly [number, number, number, number];
}

/**
 * Calculates pixel-precise safe zone bounds for a specified platform and canvas size.
 */
export function getSafeZoneBounds(
  platform: SafeZonePlatform = "universal",
  canvas: { width: number; height: number } = REFERENCE_CANVAS,
): SafeZoneBounds {
  // eslint-disable-next-line security/detect-object-injection -- closed enum key
  const spec = PLATFORM_SAFE_ZONES[platform];
  const widthRatio = canvas.width / REFERENCE_CANVAS.width;
  const heightRatio = canvas.height / REFERENCE_CANVAS.height;

  const left = Math.round(spec.leftMarginPx * widthRatio);
  const top = Math.round(spec.topMarginPx * heightRatio);
  const right = Math.round(canvas.width - spec.rightMarginPx * widthRatio);
  const bottom = Math.round(canvas.height - spec.bottomMarginPx * heightRatio);
  const defaultCaptionY = Math.round(spec.defaultCaptionY * heightRatio);
  const maxBaselineY = Math.round(MAX_BOTTOM_BASELINE_Y_PX * heightRatio);

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    defaultCaptionY,
    maxBaselineY,
  };
}

/**
 * Calculates platform danger/exclusion bounding boxes in canvas pixel space.
 */
export function getPlatformExclusions(
  platform: SafeZonePlatform = "universal",
  canvas: { width: number; height: number } = REFERENCE_CANVAS,
): PlatformExclusions {
  // eslint-disable-next-line security/detect-object-injection -- closed enum key
  const spec = PLATFORM_SAFE_ZONES[platform];
  const widthRatio = canvas.width / REFERENCE_CANVAS.width;
  const heightRatio = canvas.height / REFERENCE_CANVAS.height;

  const topH = Math.round(spec.topMarginPx * heightRatio);
  const bottomH = Math.round(spec.bottomMarginPx * heightRatio);
  const rightW = Math.round(spec.rightMarginPx * widthRatio);
  const leftW = Math.round(spec.leftMarginPx * widthRatio);

  return {
    top: [0, 0, canvas.width, topH],
    bottom: [0, canvas.height - bottomH, canvas.width, canvas.height],
    right: [
      canvas.width - rightW,
      Math.round(600 * heightRatio),
      canvas.width,
      Math.round(1500 * heightRatio),
    ],
    left: [0, 0, leftW, canvas.height],
  };
}

/**
 * Enforces safe-zone constraints on a `StyleDoc`:
 * 1. For all `bottom` aligned presets, enforces `defaultCaptionY = 1380` on 1920 canvas
 *    (normalized `0.7188`) to guarantee subtitles sit above platform username/description clutter.
 * 2. Constrains maximum cue width to 880 px (81.48% on 1080 canvas) centered at X = 540
 *    to prevent long lines from running beneath right-side social action buttons.
 */
export function enforceSafeZoneConstraints(style: StyleDoc): StyleDoc {
  const isBottomAnchor = style.layout.anchor.startsWith("bottom");

  let y = style.layout.y;
  if (isBottomAnchor && y > DEFAULT_BOTTOM_Y_NORMALIZED) {
    y = DEFAULT_BOTTOM_Y_NORMALIZED;
  } else if (!isBottomAnchor && y > 0.72) {
    y = 0.7;
  }

  const maxWidthPct = Math.min(style.layout.maxWidthPct, MAX_SAFE_CAPTION_WIDTH_PCT);

  return {
    ...style,
    layout: {
      ...style.layout,
      y,
      maxWidthPct,
    },
  };
}

/**
 * Checks whether a bounding box `[left, top, right, bottom]` sits strictly inside the safe zone bounds.
 */
export function isWithinSafeZone(
  box: readonly [number, number, number, number],
  platform: SafeZonePlatform = "universal",
  canvas: { width: number; height: number } = REFERENCE_CANVAS,
): boolean {
  const bounds = getSafeZoneBounds(platform, canvas);
  return (
    box[0] >= bounds.left &&
    box[1] >= bounds.top &&
    box[2] <= bounds.right &&
    box[3] <= bounds.bottom
  );
}

/**
 * Clamps a box `[left, top, right, bottom]` to remain strictly within safe zone bounds.
 */
export function clampBoxToSafeZone(
  box: readonly [number, number, number, number],
  platform: SafeZonePlatform = "universal",
  canvas: { width: number; height: number } = REFERENCE_CANVAS,
): [number, number, number, number] {
  const bounds = getSafeZoneBounds(platform, canvas);
  const width = box[2] - box[0];
  const height = box[3] - box[1];

  const minLeft = bounds.left;
  const maxLeft = Math.max(minLeft, bounds.right - width);
  const minTop = bounds.top;
  const maxTop = Math.max(minTop, bounds.bottom - height);

  const left = Math.min(Math.max(box[0], minLeft), maxLeft);
  const top = Math.min(Math.max(box[1], minTop), maxTop);

  return [left, top, left + width, top + height];
}

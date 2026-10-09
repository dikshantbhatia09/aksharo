import { z } from "zod";

/**
 * Every format a clip is prepared in (2026-09-29).
 *
 * One pasted link becomes a set of clips, and each clip becomes every format
 * the platforms below take. Many platform formats share a picture shape, so
 * the work is done once per FILE and the platform TARGETS point at the files:
 *
 *   * four VIDEO files per clip, one per shape - 9:16, 4:5, 1:1 and 16:9 -
 *     each cut from the source on its own frame (centred on the speaker), with
 *     its own face track, its captions placed off faces, and burned in;
 *   * IMAGE files taken from those videos: a frame of the captioned video
 *     (posts, carousel slides, pins, thumbnails), or a clean frame for covers
 *     and banners, where burned-in captions would read as a mistake.
 *
 * Sizes and limits were checked on 2026-09-29 against the sources listed per
 * target (platform help pages and 2026 size guides). They are what this
 * product prepares, not every size a platform accepts.
 */

/** The four shapes a clip's videos are cut in, width to height. */
export const VIDEO_SHAPES = ["9:16", "4:5", "1:1", "16:9"] as const;
export type VideoShape = (typeof VIDEO_SHAPES)[number];

/** The pixel size each shape's video is made at. */
export const VIDEO_SHAPE_SIZE: Readonly<Record<VideoShape, { width: number; height: number }>> =
  Object.freeze({
    "9:16": { width: 1080, height: 1920 },
    "4:5": { width: 1080, height: 1350 },
    "1:1": { width: 1080, height: 1080 },
    "16:9": { width: 1920, height: 1080 },
  });

/** An image made from one of a clip's videos. */
export interface ImageFile {
  readonly id: ImageFileId;
  /** The video it is taken from. */
  readonly from: VideoShape;
  /** A frame of the captioned video, or a clean frame (covers, banners). */
  readonly captioned: boolean;
  readonly width: number;
  readonly height: number;
  /** How many frames: one, or a carousel's slides spread through the clip. */
  readonly count: number;
}

export const IMAGE_FILE_IDS = [
  "portrait-post",
  "carousel",
  "square-post",
  "landscape-post",
  "vertical-image",
  "pin",
  "thumbnail",
  "youtube-banner",
  "facebook-cover",
  "facebook-event-cover",
  "facebook-group-cover",
] as const;
export type ImageFileId = (typeof IMAGE_FILE_IDS)[number];

export const IMAGE_FILES: Readonly<Record<ImageFileId, ImageFile>> = Object.freeze({
  "portrait-post": {
    id: "portrait-post",
    from: "4:5",
    captioned: true,
    width: 1080,
    height: 1350,
    count: 1,
  },
  carousel: { id: "carousel", from: "4:5", captioned: true, width: 1080, height: 1350, count: 5 },
  "square-post": {
    id: "square-post",
    from: "1:1",
    captioned: true,
    width: 1080,
    height: 1080,
    count: 1,
  },
  "landscape-post": {
    id: "landscape-post",
    from: "16:9",
    captioned: true,
    width: 1600,
    height: 900,
    count: 1,
  },
  "vertical-image": {
    id: "vertical-image",
    from: "9:16",
    captioned: true,
    width: 1080,
    height: 1920,
    count: 1,
  },
  pin: { id: "pin", from: "9:16", captioned: true, width: 1000, height: 1500, count: 1 },
  thumbnail: { id: "thumbnail", from: "16:9", captioned: true, width: 1280, height: 720, count: 1 },
  "youtube-banner": {
    id: "youtube-banner",
    from: "16:9",
    captioned: false,
    width: 2560,
    height: 1440,
    count: 1,
  },
  // Displayed at 851 x 315; made at twice that so it stays sharp on phones.
  "facebook-cover": {
    id: "facebook-cover",
    from: "16:9",
    captioned: false,
    width: 1702,
    height: 630,
    count: 1,
  },
  "facebook-event-cover": {
    id: "facebook-event-cover",
    from: "16:9",
    captioned: false,
    width: 1920,
    height: 1005,
    count: 1,
  },
  "facebook-group-cover": {
    id: "facebook-group-cover",
    from: "16:9",
    captioned: false,
    width: 1640,
    height: 856,
    count: 1,
  },
});

export const PLATFORMS = [
  "Instagram",
  "Facebook",
  "YouTube",
  "WhatsApp",
  "Threads",
  "X",
  "Pinterest",
  "TikTok",
] as const;
export type Platform = (typeof PLATFORMS)[number];

/** One place a clip can be posted, and the file that fits it. */
export interface FormatTarget {
  readonly id: string;
  readonly platform: Platform;
  readonly label: string;
  /** The video shape, or the image file, that fits it. */
  readonly file:
    | { readonly kind: "video"; readonly shape: VideoShape }
    | {
        readonly kind: "image";
        readonly image: ImageFileId;
      };
  /** The longest video the platform takes here, when it limits it. */
  readonly maxDurationMs?: number;
  /** One line a person needs before posting (a safe area, a limit). */
  readonly note?: string;
}

const video = (shape: VideoShape) => ({ kind: "video" as const, shape });
const image = (id: ImageFileId) => ({ kind: "image" as const, image: id });

export const FORMAT_TARGETS: readonly FormatTarget[] = Object.freeze([
  // Instagram
  {
    id: "instagram-reel",
    platform: "Instagram",
    label: "Reel",
    file: video("9:16"),
    maxDurationMs: 180_000,
  },
  {
    id: "instagram-story",
    platform: "Instagram",
    label: "Story",
    file: video("9:16"),
    maxDurationMs: 60_000,
    note: "A story plays up to 60 s; a longer clip is split into several.",
  },
  {
    id: "instagram-feed-video",
    platform: "Instagram",
    label: "Post (video, 4:5)",
    file: video("4:5"),
  },
  {
    id: "instagram-square-video",
    platform: "Instagram",
    label: "Post (video, square)",
    file: video("1:1"),
  },
  {
    id: "instagram-post-image",
    platform: "Instagram",
    label: "Post (image, 4:5)",
    file: image("portrait-post"),
  },
  {
    id: "instagram-carousel",
    platform: "Instagram",
    label: "Carousel (5 slides)",
    file: image("carousel"),
    note: "The profile grid previews posts at 3:4; keep faces and words away from the top and bottom edges.",
  },
  // Facebook
  {
    id: "facebook-reel",
    platform: "Facebook",
    label: "Reel",
    file: video("9:16"),
    maxDurationMs: 90_000,
  },
  {
    id: "facebook-story",
    platform: "Facebook",
    label: "Story",
    file: video("9:16"),
    maxDurationMs: 60_000,
  },
  {
    id: "facebook-feed-video",
    platform: "Facebook",
    label: "Feed video (4:5)",
    file: video("4:5"),
  },
  {
    id: "facebook-landscape-video",
    platform: "Facebook",
    label: "Feed video (landscape)",
    file: video("16:9"),
  },
  {
    id: "facebook-post-image",
    platform: "Facebook",
    label: "Feed image (4:5)",
    file: image("portrait-post"),
  },
  {
    id: "facebook-cover",
    platform: "Facebook",
    label: "Page cover (banner)",
    file: image("facebook-cover"),
    note: "Shown at 851 x 315; phones crop the sides, so the middle 640 x 312 is always visible.",
  },
  {
    id: "facebook-event-cover",
    platform: "Facebook",
    label: "Event cover",
    file: image("facebook-event-cover"),
  },
  {
    id: "facebook-group-cover",
    platform: "Facebook",
    label: "Group cover",
    file: image("facebook-group-cover"),
  },
  // YouTube
  {
    id: "youtube-short",
    platform: "YouTube",
    label: "Short",
    file: video("9:16"),
    maxDurationMs: 180_000,
  },
  { id: "youtube-video", platform: "YouTube", label: "Video (16:9)", file: video("16:9") },
  { id: "youtube-thumbnail", platform: "YouTube", label: "Thumbnail", file: image("thumbnail") },
  {
    id: "youtube-post",
    platform: "YouTube",
    label: "Community post image",
    file: image("square-post"),
  },
  {
    id: "youtube-banner",
    platform: "YouTube",
    label: "Channel banner",
    file: image("youtube-banner"),
    note: "Only the middle 1546 x 423 shows on every device.",
  },
  // WhatsApp
  {
    id: "whatsapp-status",
    platform: "WhatsApp",
    label: "Status (video)",
    file: video("9:16"),
    maxDurationMs: 90_000,
  },
  {
    id: "whatsapp-status-image",
    platform: "WhatsApp",
    label: "Status (image)",
    file: image("vertical-image"),
  },
  // Threads
  {
    id: "threads-video",
    platform: "Threads",
    label: "Video",
    file: video("9:16"),
    maxDurationMs: 300_000,
  },
  { id: "threads-image", platform: "Threads", label: "Image (4:5)", file: image("portrait-post") },
  // X
  {
    id: "x-video",
    platform: "X",
    label: "Video (16:9)",
    file: video("16:9"),
    maxDurationMs: 140_000,
    note: "Standard accounts post up to 2 min 20 s; Premium goes longer.",
  },
  {
    id: "x-square-video",
    platform: "X",
    label: "Video (square)",
    file: video("1:1"),
    maxDurationMs: 140_000,
  },
  { id: "x-image", platform: "X", label: "Image (16:9)", file: image("landscape-post") },
  // Pinterest
  {
    id: "pinterest-video-pin",
    platform: "Pinterest",
    label: "Video pin",
    file: video("9:16"),
    maxDurationMs: 900_000,
  },
  { id: "pinterest-pin", platform: "Pinterest", label: "Pin (2:3 image)", file: image("pin") },
  // TikTok
  { id: "tiktok-video", platform: "TikTok", label: "Video", file: video("9:16") },
] satisfies FormatTarget[]);

/**
 * Two-Speaker Vertical Split-Screen Layout Engine (Pillar 3 §02).
 *
 * Rectangular crop coordinates in source video pixels for one speaker pane.
 */
export interface SplitScreenCropBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Dual crop configuration for stacking two primary speakers vertically inside a
 * 9:16 vertical canvas (Top Pane: Host / Speaker 1; Bottom Pane: Guest / Speaker 2).
 */
export interface SplitScreenConfig {
  readonly enabled: boolean;
  readonly topCrop: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly bottomCrop: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly dividerColor?: string;
  readonly activeSpeakerHighlight?: boolean;
}

export const SPLIT_SCREEN_MODES = ["SPLIT_SCREEN", "SOLO_FULL_SCREEN"] as const;
export type SplitScreenMode = (typeof SPLIT_SCREEN_MODES)[number];

/**
 * Timeline segment alternating between split-screen during rapid dialogue and
 * solo full-screen during extended monologues.
 */
export interface SplitScreenSegment {
  readonly startSec: number;
  readonly endSec: number;
  readonly mode: SplitScreenMode;
  readonly activeSpeaker?: "top" | "bottom";
}

export const SPLIT_SCREEN_CANVAS = Object.freeze({
  width: 1080,
  height: 1920,
  paneWidth: 1080,
  paneHeight: 960,
  dividerY: 959,
  dividerHeight: 2,
  defaultDividerColor: "#1A1A1A",
  activeSpeakerScale: 1.02,
});

export const SplitScreenCropBoxSchema = z.strictObject({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const SplitScreenConfigSchema = z.strictObject({
  enabled: z.boolean(),
  topCrop: SplitScreenCropBoxSchema,
  bottomCrop: SplitScreenCropBoxSchema,
  dividerColor: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional(),
  activeSpeakerHighlight: z.boolean().optional(),
});

export const SplitScreenSegmentSchema = z.strictObject({
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  mode: z.enum(SPLIT_SCREEN_MODES),
  activeSpeaker: z.enum(["top", "bottom"]).optional(),
});

/**
 * Multi-Speaker Grid & Dynamic Camera Switcher Engine (Pillar 3 §03).
 *
 * Layout types supported by the Automated Multi-Cam Director Engine:
 * - `SOLO`: Full-screen active speaker close-up (1080 × 1920)
 * - `SPLIT_2`: Vertical 2-way split (Top 1080 × 960, Bottom 1080 × 960)
 * - `TRI_PANEL`: Active Speaker in Top 60% (1080 × 1152), Two Panelists in Bottom 40% (2 × 540 × 768)
 * - `GRID_4`: 2×2 reaction grid (4 × 540 × 960)
 */
export const DIRECTOR_LAYOUT_TYPES = ["SOLO", "SPLIT_2", "TRI_PANEL", "GRID_4"] as const;
export type DirectorLayoutType = (typeof DIRECTOR_LAYOUT_TYPES)[number];

export interface LayoutPaneAssignment {
  readonly speakerId: string;
  readonly cropRect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly canvasPosition: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/**
 * Timed Edit Decision List (EDL) camera cut and multi-pane grid assignment (Pillar 3 §03 §4.1).
 */
export interface LayoutCut {
  readonly startSec: number;
  readonly endSec: number;
  readonly layoutType: "SOLO" | "SPLIT_2" | "TRI_PANEL" | "GRID_4";
  readonly activeSpeakerId: string;
  readonly paneAssignments: Array<{
    readonly speakerId: string;
    readonly cropRect: { x: number; y: number; width: number; height: number };
    readonly canvasPosition: { x: number; y: number; width: number; height: number };
  }>;
}

/**
 * Manual timestamp layout override set by a creator in the editor (Pillar 3 §03 §5 Step 3).
 */
export interface LayoutOverride {
  readonly timestampSec: number;
  readonly layoutType: DirectorLayoutType;
  readonly activeSpeakerId?: string;
}

export const DIRECTOR_CANVAS = Object.freeze({
  width: 1080,
  height: 1920,
  minShotDurationSec: 2.0,
  falseSwitchMaxDurationSec: 1.2,
  leadInPaddingSec: 0.25,
  leadOutPaddingSec: 0.35,
  crossfadeDurationSec: 0.15,
  triPanelTopHeight: 1152, // 60% of 1920
  triPanelBottomHeight: 768, // 40% of 1920
  triPanelBottomTileWidth: 540, // 50% of 1080
  grid4TileWidth: 540,
  grid4TileHeight: 960,
});

export const DirectorLayoutTypeSchema = z.enum(DIRECTOR_LAYOUT_TYPES);

export const LayoutRectSchema = z.strictObject({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const LayoutPaneAssignmentSchema = z.strictObject({
  speakerId: z.string().trim().min(1).max(120),
  cropRect: LayoutRectSchema,
  canvasPosition: LayoutRectSchema,
});

export const LayoutCutSchema = z
  .strictObject({
    startSec: z.number().nonnegative(),
    endSec: z.number().nonnegative(),
    layoutType: DirectorLayoutTypeSchema,
    activeSpeakerId: z.string().trim().min(1).max(120),
    paneAssignments: z.array(LayoutPaneAssignmentSchema).min(1).max(8),
  })
  .superRefine((value, context) => {
    if (value.endSec <= value.startSec) {
      context.addIssue({
        code: "custom",
        path: ["endSec"],
        message: "LayoutCut endSec must be greater than startSec.",
      });
    }
  });

export const LayoutOverrideSchema = z.strictObject({
  timestampSec: z.number().nonnegative(),
  layoutType: DirectorLayoutTypeSchema,
  activeSpeakerId: z.string().trim().min(1).max(120).optional(),
});

export const DirectorEdlSchema = z.array(LayoutCutSchema).max(500);

/**
 * Blurred Background Canvas Fit Engine (Pillar 3 §05).
 *
 * High-level video layout modes for vertical short-form repurposing:
 * - `CROP_FACE`: Active speaker face crop (Pillar 3 §01)
 * - `SPLIT_TWO_SPEAKER`: Two-speaker vertical split-screen (Pillar 3 §02)
 * - `BLURRED_FIT`: Blurred background 9:16 canvas with un-cropped 16:9 foreground (Pillar 3 §05)
 * - `STREAMER_SPLIT`: Streamer webcam + gameplay split (Pillar 3 §06)
 */
export const VIDEO_LAYOUT_MODES = [
  "CROP_FACE",
  "SPLIT_TWO_SPEAKER",
  "BLURRED_FIT",
  "STREAMER_SPLIT",
] as const;

export type VideoLayoutMode = "CROP_FACE" | "SPLIT_TWO_SPEAKER" | "BLURRED_FIT" | "STREAMER_SPLIT";

export const VideoLayoutModeSchema = z.enum(VIDEO_LAYOUT_MODES);

/**
 * Styling and geometry configuration for Blurred Background Canvas Fit (16:9 in 9:16).
 */
export interface BlurredFitConfig {
  readonly enabled: boolean;
  /** Heavy Gaussian / box blur radius in px (default 35). */
  readonly blurRadius?: number;
  /** Luminance attenuation factor 0..1 (default 0.65, darkening by 35%). */
  readonly dimOpacity?: number;
  /** Background saturation boost multiplier (default 1.2). */
  readonly saturation?: number;
  /** Subtle corner rounding radius in px on the un-cropped 16:9 foreground (default 16). */
  readonly borderRadius?: number;
  /** Foreground vertical position in px on a 1080 × 1920 canvas (default 656). */
  readonly foregroundY?: number;
  /** Lower blurred safe-zone Y position in px for dynamic kinetic captions (default 1450). */
  readonly captionZoneY?: number;
}

export const BLURRED_FIT_CANVAS = Object.freeze({
  width: 1080,
  height: 1920,
  foregroundWidth: 1080,
  foregroundHeight: 608,
  foregroundY: 656,
  blurRadius: 35,
  cssBlurRadius: 40,
  dimOpacity: 0.65,
  colorChannelFactor: 0.6,
  saturation: 1.2,
  borderRadius: 16,
  boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.7)",
  captionZoneY: 1450,
});

export const BlurredFitConfigSchema = z.strictObject({
  enabled: z.boolean(),
  blurRadius: z.number().min(1).max(120).optional(),
  dimOpacity: z.number().min(0.1).max(1).optional(),
  saturation: z.number().min(0.5).max(3).optional(),
  borderRadius: z.number().min(0).max(64).optional(),
  foregroundY: z.number().nonnegative().max(1920).optional(),
  captionZoneY: z.number().nonnegative().max(1920).optional(),
});

/**
 * Multi-Aspect Ratio Engine (9:16, 1:1, 4:5, 16:9) & Simultaneous Multi-Format Batch Export (Pillar 3 §06).
 */
export const MULTI_ASPECT_RATIOS = ["9:16", "1:1", "4:5", "16:9"] as const;
export type MultiAspectRatio = (typeof MULTI_ASPECT_RATIOS)[number];

export const MULTI_ASPECT_RESOLUTIONS = ["720p", "1080p", "4k"] as const;
export type MultiAspectResolution = (typeof MULTI_ASPECT_RESOLUTIONS)[number];

export interface MultiAspectExportTarget {
  readonly aspect: "9:16" | "1:1" | "4:5" | "16:9";
  readonly resolution: "720p" | "1080p" | "4k";
}

export interface MultiAspectExportPayload {
  readonly clipId: string;
  readonly targets: Array<{
    readonly aspect: "9:16" | "1:1" | "4:5" | "16:9";
    readonly resolution: "720p" | "1080p" | "4k";
  }>;
}

export const MULTI_ASPECT_RATIO_NUMBERS: Readonly<
  Record<MultiAspectRatio, { readonly width: number; readonly height: number }>
> = Object.freeze({
  "9:16": { width: 9, height: 16 },
  "1:1": { width: 1, height: 1 },
  "4:5": { width: 4, height: 5 },
  "16:9": { width: 16, height: 9 },
});

export const MULTI_ASPECT_DIMENSIONS: Readonly<
  Record<
    MultiAspectRatio,
    Readonly<Record<MultiAspectResolution, { readonly width: number; readonly height: number }>>
  >
> = Object.freeze({
  "9:16": Object.freeze({
    "720p": Object.freeze({ width: 720, height: 1280 }),
    "1080p": Object.freeze({ width: 1080, height: 1920 }),
    "4k": Object.freeze({ width: 2160, height: 3840 }),
  }),
  "1:1": Object.freeze({
    "720p": Object.freeze({ width: 720, height: 720 }),
    "1080p": Object.freeze({ width: 1080, height: 1080 }),
    "4k": Object.freeze({ width: 2160, height: 2160 }),
  }),
  "4:5": Object.freeze({
    "720p": Object.freeze({ width: 720, height: 900 }),
    "1080p": Object.freeze({ width: 1080, height: 1350 }),
    "4k": Object.freeze({ width: 2160, height: 2700 }),
  }),
  "16:9": Object.freeze({
    "720p": Object.freeze({ width: 1280, height: 720 }),
    "1080p": Object.freeze({ width: 1920, height: 1080 }),
    "4k": Object.freeze({ width: 3840, height: 2160 }),
  }),
});

export interface MultiAspectPresetMetadata {
  readonly aspect: MultiAspectRatio;
  readonly label: string;
  readonly shortLabel: string;
  readonly platformSummary: string;
  readonly filenameSlug: string;
  readonly baseFontSizePx: number;
  readonly defaultWidth: number;
  readonly defaultHeight: number;
}

export const MULTI_ASPECT_PRESETS: Readonly<Record<MultiAspectRatio, MultiAspectPresetMetadata>> =
  Object.freeze({
    "9:16": Object.freeze({
      aspect: "9:16",
      label: "Vertical 9:16",
      shortLabel: "9:16",
      platformSummary: "TikTok · Instagram Reels · YouTube Shorts",
      filenameSlug: "reels_9x16",
      baseFontSizePx: 54,
      defaultWidth: 1080,
      defaultHeight: 1920,
    }),
    "1:1": Object.freeze({
      aspect: "1:1",
      label: "Square 1:1",
      shortLabel: "1:1",
      platformSummary: "LinkedIn Feed · Instagram Square · X",
      filenameSlug: "linkedin_1x1",
      baseFontSizePx: 42,
      defaultWidth: 1080,
      defaultHeight: 1080,
    }),
    "4:5": Object.freeze({
      aspect: "4:5",
      label: "Portrait 4:5",
      shortLabel: "4:5",
      platformSummary: "Instagram Feed · Facebook Home Feed",
      filenameSlug: "feed_4x5",
      baseFontSizePx: 48,
      defaultWidth: 1080,
      defaultHeight: 1350,
    }),
    "16:9": Object.freeze({
      aspect: "16:9",
      label: "Landscape 16:9",
      shortLabel: "16:9",
      platformSummary: "YouTube · Webinar Recaps · Desktop",
      filenameSlug: "youtube_16x9",
      baseFontSizePx: 44,
      defaultWidth: 1920,
      defaultHeight: 1080,
    }),
  });

export function resolveMultiAspectDimensions(
  aspect: MultiAspectRatio,
  resolution: MultiAspectResolution = "1080p",
): { readonly width: number; readonly height: number } {
  // eslint-disable-next-line security/detect-object-injection -- closed enum keys
  return MULTI_ASPECT_DIMENSIONS[aspect][resolution];
}

/**
 * Compute target crop rectangle for any aspect ratio (9:16, 1:1, 4:5, 16:9)
 * centered on normalized face coordinates (cx, cy) in [0.0, 1.0] x [0.0, 1.0],
 * clamped to source frame boundaries and aligned to even pixel boundaries (Pillar 3 §06 §2.1):
 *   crop_w = min(W_src, H_src * W_T / H_T)
 *   crop_h = min(H_src, W_src * H_T / W_T)
 */
export function computeMultiAspectCrop(
  sourceWidth: number,
  sourceHeight: number,
  aspect: MultiAspectRatio,
  centerX = 0.5,
  centerY = 0.5,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const safeW = Math.max(2, Math.floor(sourceWidth / 2) * 2);
  const safeH = Math.max(2, Math.floor(sourceHeight / 2) * 2);
  // eslint-disable-next-line security/detect-object-injection -- closed enum key
  const ratio = MULTI_ASPECT_RATIO_NUMBERS[aspect];
  const rawCropW = Math.min(safeW, (safeH * ratio.width) / ratio.height);
  const rawCropH = Math.min(safeH, (safeW * ratio.height) / ratio.width);
  const cropW = Math.max(2, Math.min(safeW, Math.round(rawCropW / 2) * 2));
  const cropH = Math.max(2, Math.min(safeH, Math.round(rawCropH / 2) * 2));

  const cx = Number.isFinite(centerX) ? Math.min(1, Math.max(0, centerX)) : 0.5;
  const cy = Number.isFinite(centerY) ? Math.min(1, Math.max(0, centerY)) : 0.5;

  const rawX = Math.round(cx * safeW - cropW / 2);
  const rawY = Math.round(cy * safeH - cropH / 2);
  const clampedX = Math.min(Math.max(0, rawX), Math.max(0, safeW - cropW));
  const clampedY = Math.min(Math.max(0, rawY), Math.max(0, safeH - cropH));

  return {
    x: Math.floor(clampedX / 2) * 2,
    y: Math.floor(clampedY / 2) * 2,
    width: cropW,
    height: cropH,
  };
}

export const MultiAspectRatioSchema = z.enum(MULTI_ASPECT_RATIOS);
export const MultiAspectResolutionSchema = z.enum(MULTI_ASPECT_RESOLUTIONS);

export const MultiAspectExportTargetSchema = z.strictObject({
  aspect: MultiAspectRatioSchema,
  resolution: MultiAspectResolutionSchema,
});

export const MultiAspectExportPayloadSchema = z
  .strictObject({
    clipId: z.string().trim().min(1).max(120),
    targets: z.array(MultiAspectExportTargetSchema).min(1).max(4),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < value.targets.length; index += 1) {
      // eslint-disable-next-line security/detect-object-injection -- bounded numeric index
      const target = value.targets[index];
      if (target === undefined) continue;
      const key = `${target.aspect}:${target.resolution}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["targets", index, "aspect"],
          message: `Duplicate export target ${key}.`,
        });
      }
      seen.add(key);
    }
  });

export interface MultiAspectVariantOutput {
  readonly aspect: MultiAspectRatio;
  readonly aspectRatio?: MultiAspectRatio;
  readonly resolution: MultiAspectResolution;
  readonly width: number;
  readonly height: number;
  readonly crop: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly captionFontSizePx: number;
  readonly captionYOffsetPx: number;
  readonly filename: string;
  readonly status: "ready" | "rendering" | "preparing";
  readonly downloadUrl: string;
}

export interface MultiAspectExportResult {
  readonly clipId: string;
  readonly runId?: string;
  readonly candidateId: string;
  readonly batchJobId: string;
  readonly variants: readonly MultiAspectVariantOutput[];
  readonly enqueued?: readonly string[];
}



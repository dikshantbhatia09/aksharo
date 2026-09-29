/**
 * Where a clip's 9:16 window sits in its source, and how tall the mezzanine is.
 *
 * Two integers per side, computed here rather than as `crop`/`scale` expressions
 * in the filtergraph, for the reason `proxySize` gives in `ffmpeg/derive.ts`:
 * every comma in an expression has to survive two levels of ffmpeg's parser,
 * and a mistake there fails at runtime on exactly the aspect ratio nobody tried.
 * Numbers computed in TypeScript are testable in a millisecond.
 *
 * Until 2026-09-26 the window was always the frame centre and the output was
 * always 720 x 1280. On a 16:9 interview the centre window is the middle third
 * of the frame, so a speaker sitting on a thirds line was cut out of the clip
 * before face-aware captions ever ran; and every 1080 x 1920 export of a clip
 * scaled a 720-wide picture up by half again.
 *
 * The mezzanine is now as tall as the source allows, up to 1080 x 1920 — but a
 * landscape source's window is only as tall as the source itself, so it takes
 * a 2160p source to fill the canvas (a 1216 x 2160 window, scaled down). 1440p
 * gives 810 x 1440 and 1080p only 608 x 1080, which the export scales up
 * 1.78x. That is why acquisition (`chooseFormat` in `yt-dlp.ts`) fetches up to
 * 2160p whenever the plan's byte cap allows it and the download can arrive
 * inside its time limit, rather than stopping at 1080p.
 */

/**
 * The shapes a clip is cut in (2026-09-29), width to height: 9:16 for Reels,
 * Shorts, Stories and Status; 4:5 for feed posts; 1:1 for square posts; 16:9
 * for YouTube and landscape posts. A payload with none is cut 9:16.
 */
export const CLIP_ASPECTS = {
  "9:16": { width: 9, height: 16 },
  "4:5": { width: 4, height: 5 },
  "1:1": { width: 1, height: 1 },
  "16:9": { width: 16, height: 9 },
} as const;
export type ClipAspect = keyof typeof CLIP_ASPECTS;

/**
 * The tallest mezzanine this worker cuts, whatever the payload asks for.
 *
 * 1920 is the 9:16 clip project's canvas (1080 x 1920). Every export draws the
 * mezzanine onto that canvas, so a taller picture is only bytes the export
 * scales back down. Reaching it needs a 9:16 window at least 1920 tall: a
 * landscape source at least that tall (in practice 2160p), or a portrait one
 * at least 1080 wide, like a 1080 x 1920 Short.
 */
export const MAX_CLIP_HEIGHT = 1920;

/** Where the window goes when the payload says nothing: the frame centre. */
export const DEFAULT_CENTER_X = 0.5;
export const DEFAULT_CENTER_Y = 0.5;

export interface ClipFrame {
  /** The picture size the crop was computed for: the source as probed. */
  readonly source: { readonly width: number; readonly height: number };
  /** The window cut out of the source, in the source's displayed pixels. */
  readonly crop: {
    readonly width: number;
    readonly height: number;
    readonly x: number;
    readonly y: number;
  };
  /** The mezzanine's size. Equal to the crop when the crop is short enough. */
  readonly output: { readonly width: number; readonly height: number };
}

export interface ClipFrameOptions {
  /** `profile.maxHeight`; capped at {@link MAX_CLIP_HEIGHT}. */
  readonly maxHeight?: number;
  /** `reframe.centerX`: the window's centre as a fraction of the source width. */
  readonly centerX?: number;
  /** `reframe.centerY`: the window's centre as a fraction of the source height. */
  readonly centerY?: number;
  /** The shape to cut; 9:16 when absent. */
  readonly aspect?: ClipAspect;
}

/**
 * The window and the output size for a source of `width` x `height`.
 *
 * `width` and `height` are the picture as displayed — after rotation, which is
 * how `readVideo` reports them and how ffmpeg's autorotate hands the frame to
 * the filtergraph.
 *
 * - A source wider than the shape keeps its full height; the window slides
 *   across it to centre on `centerX`, clamped so it never leaves the frame.
 * - A source taller than the shape keeps its full width; the window slides up
 *   or down to centre on `centerY` (the middle when absent), clamped likewise.
 * - The output is the crop, scaled down to `maxHeight` when the crop is taller.
 *   It is never scaled up: a 720p source makes a 406 x 720 9:16 mezzanine, and
 *   inventing pixels here would only make every later encode slower.
 *
 * Returns `null` when the source has no usable picture size.
 */
export function clipFrame(
  source: { readonly width: number; readonly height: number },
  options: ClipFrameOptions = {},
): ClipFrame | null {
  const { width, height } = source;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return null;
  const shape = CLIP_ASPECTS[options.aspect ?? "9:16"];

  let crop: ClipFrame["crop"];
  if (width * shape.height > height * shape.width) {
    const cropHeight = floorEven(height);
    const cropWidth = Math.min(even((cropHeight * shape.width) / shape.height), floorEven(width));
    const centerX = finiteOr(options.centerX, DEFAULT_CENTER_X);
    const left = clamp(Math.round(centerX * width - cropWidth / 2), 0, width - cropWidth);
    crop = {
      width: cropWidth,
      height: cropHeight,
      x: Math.floor(left / 2) * 2,
      y: Math.floor((height - cropHeight) / 4) * 2,
    };
  } else {
    const cropWidth = floorEven(width);
    const cropHeight = Math.min(floorEven(height), even((cropWidth * shape.height) / shape.width));
    const centerY = finiteOr(options.centerY, DEFAULT_CENTER_Y);
    const top = clamp(Math.round(centerY * height - cropHeight / 2), 0, height - cropHeight);
    crop = {
      width: cropWidth,
      height: cropHeight,
      x: 0,
      y: Math.floor(top / 2) * 2,
    };
  }

  const limit = floorEven(
    Math.min(
      typeof options.maxHeight === "number" && Number.isFinite(options.maxHeight)
        ? options.maxHeight
        : MAX_CLIP_HEIGHT,
      MAX_CLIP_HEIGHT,
    ),
  );
  const output =
    crop.height > limit
      ? { width: even((limit * shape.width) / shape.height), height: limit }
      : { width: crop.width, height: crop.height };

  return { source: { width, height }, crop, output };
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * The `-vf` chain that cuts `frame` out of the source.
 *
 * It opens by scaling every frame to the size the probe read, which is a
 * pass-through (ffmpeg's scale hands an identically sized frame straight on) for
 * every source whose picture size never changes. It is there for the ones whose
 * size does change mid-stream: a screen or WebRTC recording, an adaptive
 * re-encode. ffmpeg rebuilds the filtergraph at each new size, and a fixed crop
 * wider or taller than the new picture fails the whole cut with "Error
 * reinitializing filters!" — every attempt, for a source the old expression
 * crop handled. Scaled back first, the crop's numbers always fit (a picture
 * whose shape changed too is stretched back to the probed shape, which beats no
 * clip at all).
 */
export function clipFilter(frame: ClipFrame): string {
  const { source, crop, output } = frame;
  const scaled = output.width !== crop.width || output.height !== crop.height;
  return [
    `scale=${String(source.width)}:${String(source.height)}`,
    `crop=${String(crop.width)}:${String(crop.height)}:${String(crop.x)}:${String(crop.y)}`,
    ...(scaled ? [`scale=${String(output.width)}:${String(output.height)}:flags=bicubic`] : []),
    "setsar=1",
    // The run page plays the mezzanine itself, and a browser cannot play the
    // 10-bit H.264 that a 10-bit source would otherwise produce.
    "format=yuv420p",
  ].join(",");
}

/** Round to an even number ≥ 2: H.264 4:2:0 cannot encode odd dimensions. */
function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/** The largest even number ≤ `value` (and ≥ 2): a crop may not exceed the frame. */
function floorEven(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

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

/** A vertical short: nine wide, sixteen tall. */
const ASPECT_WIDTH = 9;
const ASPECT_HEIGHT = 16;

/**
 * The tallest mezzanine this worker cuts, whatever the payload asks for.
 *
 * 1920 is the clip project's canvas (1080 x 1920). Every export draws the
 * mezzanine onto that canvas, so a taller picture is only bytes the export
 * scales back down. Reaching it needs a 9:16 window at least 1920 tall: a
 * landscape source at least that tall (in practice 2160p), or a portrait one
 * at least 1080 wide, like a 1080 x 1920 Short.
 */
export const MAX_CLIP_HEIGHT = 1920;

/** Where the window goes when the payload says nothing: the frame centre. */
export const DEFAULT_CENTER_X = 0.5;

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
}

/**
 * The window and the output size for a source of `width` x `height`.
 *
 * `width` and `height` are the picture as displayed — after rotation, which is
 * how `readVideo` reports them and how ffmpeg's autorotate hands the frame to
 * the filtergraph.
 *
 * - A source wider than 9:16 keeps its full height; the window slides across it
 *   to centre on `centerX`, clamped so it never leaves the frame.
 * - A source that is already 9:16 or narrower has nothing to cut sideways. A
 *   narrower one (a tall phone screen recording) loses its top and bottom
 *   equally, as it always has.
 * - The output is the crop, scaled down to `maxHeight` when the crop is taller.
 *   It is never scaled up: a 720p source makes a 406 x 720 mezzanine, and
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

  let crop: ClipFrame["crop"];
  if (width * ASPECT_HEIGHT > height * ASPECT_WIDTH) {
    const cropHeight = floorEven(height);
    const cropWidth = Math.min(even((cropHeight * ASPECT_WIDTH) / ASPECT_HEIGHT), floorEven(width));
    const centerX =
      typeof options.centerX === "number" && Number.isFinite(options.centerX)
        ? options.centerX
        : DEFAULT_CENTER_X;
    const left = clamp(Math.round(centerX * width - cropWidth / 2), 0, width - cropWidth);
    crop = {
      width: cropWidth,
      height: cropHeight,
      // Even offsets: ffmpeg's crop rounds a 4:2:0 picture's offsets down to
      // even anyway, and saying so here keeps the numbers what was cut.
      x: Math.floor(left / 2) * 2,
      y: Math.floor((height - cropHeight) / 4) * 2,
    };
  } else {
    const cropWidth = floorEven(width);
    const cropHeight = Math.min(
      floorEven(height),
      even((cropWidth * ASPECT_HEIGHT) / ASPECT_WIDTH),
    );
    crop = {
      width: cropWidth,
      height: cropHeight,
      x: 0,
      y: Math.floor((height - cropHeight) / 4) * 2,
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
      ? { width: even((limit * ASPECT_WIDTH) / ASPECT_HEIGHT), height: limit }
      : { width: crop.width, height: crop.height };

  return { source: { width, height }, crop, output };
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

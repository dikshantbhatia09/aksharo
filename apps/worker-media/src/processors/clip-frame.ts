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

export interface CropKeyframe {
  readonly timeSec: number;
  readonly centerX: number; // 0.0 - 1.0
  readonly centerY: number; // 0.0 - 1.0
  readonly zoom: number; // 1.0 - 1.5
}

export interface DynamicReframeTrajectory {
  readonly keyframes: readonly CropKeyframe[];
  readonly interpolation: "SPRING_DAMPED" | "CUBIC_BEZIER";
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
  /** Optional time-varying crop trajectory (Pillar 3 §01). */
  readonly trajectory?: DynamicReframeTrajectory;
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
 * Evaluate the interpolated crop keyframe at `timeSec` for a {@link DynamicReframeTrajectory}.
 */
export function interpolateTrajectoryAt(
  trajectory: DynamicReframeTrajectory,
  timeSec: number,
): CropKeyframe {
  const { keyframes, interpolation } = trajectory;
  const first = keyframes[0];
  if (first === undefined) {
    return { timeSec: Math.max(0, timeSec), centerX: DEFAULT_CENTER_X, centerY: DEFAULT_CENTER_Y, zoom: 1 };
  }
  if (keyframes.length === 1 || timeSec <= first.timeSec) {
    return { ...first, timeSec: Math.max(0, timeSec) };
  }
  const last = keyframes[keyframes.length - 1] ?? first;
  if (timeSec >= last.timeSec) {
    return { ...last, timeSec };
  }

  for (let i = 0; i < keyframes.length - 1; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- bounded numeric index
    const start = keyframes[i] ?? first;
    const end = keyframes[i + 1] ?? last;
    if (timeSec >= start.timeSec && timeSec <= end.timeSec) {
      const span = end.timeSec - start.timeSec;
      const rawU = span > 1e-6 ? clamp((timeSec - start.timeSec) / span, 0, 1) : 1;
      const u =
        interpolation === "CUBIC_BEZIER"
          ? rawU * rawU * (3 - 2 * rawU)
          : 1 - (1 + 2.5 * rawU) * Math.exp(-2.5 * rawU) / (1 - 3.5 * Math.exp(-2.5) + 1e-9) * (1 - 3.5 * Math.exp(-2.5));
      const factor = clamp(interpolation === "CUBIC_BEZIER" ? u : rawU, 0, 1);
      return {
        timeSec,
        centerX: start.centerX + (end.centerX - start.centerX) * factor,
        centerY: start.centerY + (end.centerY - start.centerY) * factor,
        zoom: start.zoom + (end.zoom - start.zoom) * factor,
      };
    }
  }
  return { ...last, timeSec };
}

/**
 * Compute Remotion `<Video style={{ transform: ... }} />` binding for a
 * {@link DynamicReframeTrajectory} at `timeSec`.
 */
export function remotionVideoTransform(
  trajectory: DynamicReframeTrajectory,
  timeSec: number,
): {
  readonly style: { readonly transform: string; readonly transformOrigin: string };
  readonly keyframe: CropKeyframe;
} {
  const kf = interpolateTrajectoryAt(trajectory, timeSec);
  const offsetXPercent = ((0.5 - kf.centerX) * 100).toFixed(3);
  const offsetYPercent = ((0.5 - kf.centerY) * 100).toFixed(3);
  const scale = clamp(kf.zoom, 1, 1.5).toFixed(4);
  return {
    style: {
      transform: `scale(${scale}) translate3d(${offsetXPercent}%, ${offsetYPercent}%, 0)`,
      transformOrigin: "center center",
    },
    keyframe: kf,
  };
}

function buildPiecewiseLinearExpr(
  points: readonly { readonly t: number; readonly v: number }[],
  minVal: number,
  maxVal: number,
): { readonly expr: string; readonly isDynamic: boolean } {
  const first = points[0];
  if (first === undefined || points.length < 2) {
    const fixed = String(first?.v ?? minVal);
    return { expr: fixed, isDynamic: false };
  }
  const terms: string[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- bounded numeric index
    const p0 = points[i] ?? first;
    const p1 = points[i + 1] ?? first;
    const dt = p1.t - p0.t;
    const dv = p1.v - p0.v;
    if (dt <= 1e-4 || Math.abs(dv) < 1) continue;
    const slope = dv / dt;
    const sign = slope >= 0 ? "+" : "";
    terms.push(
      `${sign}${slope.toFixed(4)}*(clip(t,${p0.t.toFixed(4)},${p1.t.toFixed(4)})-${p0.t.toFixed(4)})`,
    );
  }
  if (terms.length === 0) {
    return { expr: String(first.v), isDynamic: false };
  }
  const rawSum = `${String(first.v)}${terms.join("")}`;
  return {
    expr: `trunc(clip(${rawSum},${String(minVal)},${String(maxVal)})/2)*2`,
    isDynamic: true,
  };
}

/**
 * Build FFmpeg `crop` `x` and `y` expressions for a {@link DynamicReframeTrajectory}.
 */
export function dynamicCropExpressions(
  frame: ClipFrame,
  trajectory: DynamicReframeTrajectory,
  leadOffsetSec = 0,
): { readonly xExpr: string; readonly yExpr: string; readonly isDynamic: boolean } {
  const { source, crop } = frame;
  const maxX = Math.max(0, source.width - crop.width);
  const maxY = Math.max(0, source.height - crop.height);
  const offset = Number.isFinite(leadOffsetSec) && leadOffsetSec > 0 ? leadOffsetSec : 0;

  const xPoints = trajectory.keyframes.map((kf) => {
    const left = clamp(Math.round(kf.centerX * source.width - crop.width / 2), 0, maxX);
    return {
      t: Math.max(0, kf.timeSec + offset),
      v: Math.floor(left / 2) * 2,
    };
  });
  const yPoints = trajectory.keyframes.map((kf) => {
    const top = clamp(Math.round(kf.centerY * source.height - crop.height / 2), 0, maxY);
    return {
      t: Math.max(0, kf.timeSec + offset),
      v: Math.floor(top / 2) * 2,
    };
  });

  const panX = maxX > 0 ? buildPiecewiseLinearExpr(xPoints, 0, maxX) : { expr: String(crop.x), isDynamic: false };
  const panY = maxY > 0 ? buildPiecewiseLinearExpr(yPoints, 0, maxY) : { expr: String(crop.y), isDynamic: false };
  return {
    xExpr: panX.expr,
    yExpr: panY.expr,
    isDynamic: panX.isDynamic || panY.isDynamic,
  };
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
 *
 * When a `trajectory` with time-varying keyframes is supplied, the `crop`
 * filter smoothly pans across the keyframes using a bounded `clip(t, ...)`
 * expression evaluated per frame.
 */
export function clipFilter(
  frame: ClipFrame,
  trajectory?: DynamicReframeTrajectory,
  leadOffsetSec = 0,
): string {
  const { source, crop, output } = frame;
  const scaled = output.width !== crop.width || output.height !== crop.height;
  const dynamic =
    trajectory !== undefined && trajectory.keyframes.length >= 2
      ? dynamicCropExpressions(frame, trajectory, leadOffsetSec)
      : null;

  const cropStage =
    dynamic !== null && dynamic.isDynamic
      ? `crop=${String(crop.width)}:${String(crop.height)}:x='${dynamic.xExpr}':y='${dynamic.yExpr}'`
      : `crop=${String(crop.width)}:${String(crop.height)}:${String(crop.x)}:${String(crop.y)}`;

  return [
    `scale=${String(source.width)}:${String(source.height)}`,
    cropStage,
    ...(scaled ? [`scale=${String(output.width)}:${String(output.height)}:flags=bicubic`] : []),
    "setsar=1",
    // The run page plays the mezzanine itself, and a browser cannot play the
    // 10-bit H.264 that a 10-bit source would otherwise produce.
    "format=yuv420p",
  ].join(",");
}

/**
 * Two people, one above the other (2026-10-01, two-speaker layouts).
 *
 * A two-person podcast shot from one wide camera has its speakers on the left
 * and the right thirds; a single 9:16 window can hold only one of them, so the
 * other is cut out of every clip. A stacked cut gives each person half of the
 * picture instead: two windows cut from the source, each centred on one
 * person, scaled to the same size and stacked, the first person (the left one,
 * as the API sends them) on top. Only for 9:16 and 4:5, whose halves (9:8 and
 * 8:5) still frame a head and shoulders; a square or wide picture is never
 * stacked.
 *
 * The same rules as {@link clipFrame}, per half:
 *
 * - **Each window stays on its person's side** of the midpoint between them,
 *   and is never wider than the distance between the two, so neither half
 *   shows the other person's face - even at a frame edge, where it is clamped.
 * - **Zoomed by the face**: a window about {@link STACK_FACE_SHARE} of whose
 *   height is the face (head and shoulders), but never shorter than
 *   {@link STACK_MIN_CROP_SHARE} of the source: the mezzanine is never scaled
 *   up, so a tighter window is only a smaller picture the export enlarges.
 * - **Headroom**: the face sits on the upper third line of its half
 *   ({@link STACK_FACE_ROW}), clamped so the window never leaves the frame.
 * - **Never upscaled**: both halves are the size of the smaller window, capped
 *   at half of `maxHeight`; the larger window is scaled down to it.
 */
export interface StackedFrame {
  /** The picture size the windows were computed for: the source as probed. */
  readonly source: { readonly width: number; readonly height: number };
  /** Each person's window in the source's displayed pixels, top half first. */
  readonly crops: readonly [ClipFrame["crop"], ClipFrame["crop"]];
  /** The size each window is scaled to: one half of the mezzanine. */
  readonly half: { readonly width: number; readonly height: number };
  /** The mezzanine: the two halves, one above the other. */
  readonly output: { readonly width: number; readonly height: number };
}

/** One person of a stacked cut, as the payload names them (`reframe.people`). */
export interface StackedPersonInput {
  /** Face centre, as fractions of the source's width and height. */
  readonly centerX: number;
  readonly centerY: number;
  /** Face height, as a share of the source's height. */
  readonly size: number;
}

export interface StackedFrameOptions {
  /** `profile.maxHeight`, for the whole picture; capped at {@link MAX_CLIP_HEIGHT}. */
  readonly maxHeight?: number;
  /** 9:16 when absent. Anything but 9:16 and 4:5 is not stacked. */
  readonly aspect?: ClipAspect;
  /** Exactly two, top half first. */
  readonly people: readonly StackedPersonInput[];
}

/** The shapes a stacked cut is made in. */
export const STACKED_ASPECTS: ReadonlySet<ClipAspect> = new Set<ClipAspect>(["9:16", "4:5"]);

/**
 * How much of a half the face fills: about a fifth, so the half shows a head
 * and shoulders rather than a face filling the frame.
 */
export const STACK_FACE_SHARE = 0.22;

/** Where the face's centre sits in its half: on the upper third line. */
export const STACK_FACE_ROW = 1 / 3;

/**
 * The tightest a window is cut, as a share of the source's height. Half: a
 * stacked 1080p clip then has as many pixels as a single-window one
 * (608 x 1080), and a 2160p source fills the 1080 x 1920 canvas unscaled.
 */
export const STACK_MIN_CROP_SHARE = 0.5;

/**
 * People closer than this share of the width are one place, not two: there is
 * no window narrow enough to hold one without the other.
 */
const STACK_MIN_SEPARATION = 0.08;

/**
 * The two windows and the mezzanine size for a stacked cut of a `width` x
 * `height` source, or `null` when the source cannot be stacked: not landscape,
 * a shape that is never stacked, people not two, or two people in one place.
 * The caller then cuts one window ({@link clipFrame}).
 */
export function stackedFrame(
  source: { readonly width: number; readonly height: number },
  options: StackedFrameOptions,
): StackedFrame | null {
  const { width, height } = source;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return null;
  const aspect = options.aspect ?? "9:16";
  if (!STACKED_ASPECTS.has(aspect) || width <= height) return null;
  const [first, second] = options.people;
  if (first === undefined || second === undefined || options.people.length !== 2) return null;
  if (![first, second].every(isPerson)) return null;

  // eslint-disable-next-line security/detect-object-injection -- a closed enum (ClipAspect), not input
  const shape = CLIP_ASPECTS[aspect];
  // A half is the shape's width by half its height: 9:8 for 9:16, 8:5 for 4:5.
  const ratio = (shape.width * 2) / shape.height;

  // Each person keeps to their side of the midpoint between them.
  const firstX = first.centerX * width;
  const secondX = second.centerX * width;
  const separation = Math.abs(secondX - firstX);
  if (separation < STACK_MIN_SEPARATION * width) return null;
  const middle = (firstX + secondX) / 2;
  const widest = floorEven(Math.min(separation, middle, width - middle));
  const tallest = Math.min(floorEven(height), floorEven(widest / ratio));
  if (tallest < 16) return null;

  const window = (person: StackedPersonInput, side: "left" | "right"): ClipFrame["crop"] => {
    const wanted = (person.size * height) / STACK_FACE_SHARE;
    const floor = Math.min(STACK_MIN_CROP_SHARE * height, tallest);
    const cropHeight = floorEven(clamp(wanted, floor, tallest));
    const cropWidth = Math.min(even(cropHeight * ratio), widest);
    const [low, high] = side === "left" ? [0, middle] : [middle, width];
    const left = clamp(
      Math.round(person.centerX * width - cropWidth / 2),
      Math.max(0, Math.ceil(low)),
      Math.min(width, Math.floor(high)) - cropWidth,
    );
    const top = clamp(
      Math.round(person.centerY * height - cropHeight * STACK_FACE_ROW),
      0,
      height - cropHeight,
    );
    return {
      width: cropWidth,
      height: cropHeight,
      x: Math.floor(left / 2) * 2,
      y: Math.floor(top / 2) * 2,
    };
  };
  const firstIsLeft = firstX <= secondX;
  const crops = [
    window(first, firstIsLeft ? "left" : "right"),
    window(second, firstIsLeft ? "right" : "left"),
  ] as const;

  const limit = floorEven(
    Math.min(
      typeof options.maxHeight === "number" && Number.isFinite(options.maxHeight)
        ? options.maxHeight
        : MAX_CLIP_HEIGHT,
      MAX_CLIP_HEIGHT,
    ) / 2,
  );
  const halfHeight = floorEven(Math.min(crops[0].height, crops[1].height, limit));
  const halfWidth = Math.min(even(halfHeight * ratio), crops[0].width, crops[1].width);
  return {
    source: { width, height },
    crops,
    half: { width: halfWidth, height: halfHeight },
    output: { width: halfWidth, height: halfHeight * 2 },
  };
}

function isPerson(person: StackedPersonInput): boolean {
  return (
    Number.isFinite(person.centerX) &&
    Number.isFinite(person.centerY) &&
    Number.isFinite(person.size) &&
    person.size > 0
  );
}

/**
 * The `-vf` graph that cuts a {@link StackedFrame}: the probed-size scale
 * {@link clipFilter} opens with (so a picture that changes size mid-stream
 * still fits both windows), split in two, each half cut and scaled to the
 * common size, then stacked. Each half's sample aspect is set before the
 * stack: a scale that rounds a pixel changes it, and the halves must agree.
 */
export function stackedFilter(frame: StackedFrame): string {
  const { source, crops, half } = frame;
  const halfChain = (crop: ClipFrame["crop"]): string =>
    [
      `crop=${String(crop.width)}:${String(crop.height)}:${String(crop.x)}:${String(crop.y)}`,
      ...(crop.width !== half.width || crop.height !== half.height
        ? [`scale=${String(half.width)}:${String(half.height)}:flags=bicubic`]
        : []),
      "setsar=1",
    ].join(",");
  return [
    `scale=${String(source.width)}:${String(source.height)},split=2[top][bottom]`,
    `[top]${halfChain(crops[0])}[upper]`,
    `[bottom]${halfChain(crops[1])}[lower]`,
    // yuv420p for the same reason as a single window: the run page plays it.
    "[upper][lower]vstack=inputs=2,setsar=1,format=yuv420p",
  ].join(";");
}

export interface FitFrame {
  /** The picture size the fit was computed for: the source as probed. */
  readonly source: { readonly width: number; readonly height: number };
  /** The fitted foreground video inside the canvas */
  readonly fg: {
    readonly width: number;
    readonly height: number;
    readonly x: number;
    readonly y: number;
  };
  /** The canvas output size */
  readonly output: { readonly width: number; readonly height: number };
}

export interface FitFrameOptions {
  /** `profile.maxHeight`; capped at MAX_CLIP_HEIGHT. */
  readonly maxHeight?: number;
  /** The shape to cut; 9:16 when absent. */
  readonly aspect?: ClipAspect;
}

/** The shapes a fit cut is made in. */
export const FIT_ASPECTS: ReadonlySet<ClipAspect> = new Set<ClipAspect>(["9:16", "4:5"]);

/**
 * Fit a widescreen landscape source into a vertical/tall canvas (9:16 or 4:5)
 * without cropping off the sides (e.g. for slides, charts, screencasts, robotics).
 */
export function fitFrame(
  source: { readonly width: number; readonly height: number },
  options: FitFrameOptions = {},
): FitFrame | null {
  const { width, height } = source;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return null;
  const aspect = options.aspect ?? "9:16";
  if (!FIT_ASPECTS.has(aspect) || width <= height) return null;

  const shape = CLIP_ASPECTS[aspect];
  const limit = floorEven(
    Math.min(
      typeof options.maxHeight === "number" && Number.isFinite(options.maxHeight)
        ? options.maxHeight
        : MAX_CLIP_HEIGHT,
      MAX_CLIP_HEIGHT,
    ),
  );

  const outHeight = limit;
  const outWidth = even((limit * shape.width) / shape.height);

  const fgWidth = outWidth;
  const fgHeight = Math.min(even((fgWidth * height) / width), outHeight);
  const fgX = 0;
  const fgY = Math.floor((outHeight - fgHeight) / 4) * 2;

  return {
    source: { width, height },
    fg: { width: fgWidth, height: fgHeight, x: fgX, y: fgY },
    output: { width: outWidth, height: outHeight },
  };
}

/**
 * The -vf graph that renders a fit layout:
 * The source is split into background and foreground.
 * The background is scaled and blurred to fill the canvas.
 * The foreground is scaled to fit and overlaid in the center.
 */
export function fitFilter(frame: FitFrame): string {
  const { source, fg, output } = frame;
  return [
    `scale=${String(source.width)}:${String(source.height)},split=2[fg_in][bg_in]`,
    `[bg_in]scale=${String(output.width)}:${String(output.height)}:flags=bicubic,boxblur=20:5[bg]`,
    `[fg_in]scale=${String(fg.width)}:${String(fg.height)}:flags=bicubic[fg]`,
    `[bg][fg]overlay=${String(fg.x)}:${String(fg.y)},setsar=1,format=yuv420p`,
  ].join(";");
}

/**
 * Dual crop configuration for Two-Speaker Vertical Split-Screen Layout Engine (Pillar 3 §02).
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

export interface SplitScreenFrame extends StackedFrame {
  readonly dividerColor: string;
  readonly activeSpeakerHighlight: boolean;
}

function isSafeFfmpegColor(value: string): boolean {
  if (value.length === 0 || value.length > 32) return false;
  return (
    /^#[0-9a-fA-F]{6}$/.test(value) ||
    /^[a-zA-Z]+@[0-9.]+$/.test(value) ||
    /^[a-zA-Z]+$/.test(value)
  );
}

function sanitizeDividerColor(color: string | undefined): string {
  if (typeof color === "string" && isSafeFfmpegColor(color.trim())) {
    return color.trim();
  }
  return "black@0.6";
}

/**
 * Convert a {@link StackedFrame} into a {@link SplitScreenConfig}.
 */
export function toSplitScreenConfig(
  frame: StackedFrame,
  options: { readonly dividerColor?: string; readonly activeSpeakerHighlight?: boolean } = {},
): SplitScreenConfig {
  const [top, bottom] = frame.crops;
  return {
    enabled: true,
    topCrop: { x: top.x, y: top.y, width: top.width, height: top.height },
    bottomCrop: { x: bottom.x, y: bottom.y, width: bottom.width, height: bottom.height },
    dividerColor: options.dividerColor ?? "#1A1A1A",
    activeSpeakerHighlight: options.activeSpeakerHighlight ?? true,
  };
}

/**
 * Compute a {@link SplitScreenFrame} from explicit dual crop coordinates ({@link SplitScreenConfig}).
 */
export function splitScreenFrame(
  source: { readonly width: number; readonly height: number },
  config: SplitScreenConfig,
  options: { readonly maxHeight?: number; readonly aspect?: ClipAspect } = {},
): SplitScreenFrame | null {
  const { width, height } = source;
  if (!config.enabled) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return null;
  const aspect = options.aspect ?? "9:16";
  if (!STACKED_ASPECTS.has(aspect) || width <= height) return null;

  const sanitizeCrop = (raw: SplitScreenConfig["topCrop"]): ClipFrame["crop"] | null => {
    if (
      !Number.isFinite(raw.x) ||
      !Number.isFinite(raw.y) ||
      !Number.isFinite(raw.width) ||
      !Number.isFinite(raw.height) ||
      raw.width < 2 ||
      raw.height < 2
    ) {
      return null;
    }
    const w = Math.min(floorEven(raw.width), floorEven(width));
    const h = Math.min(floorEven(raw.height), floorEven(height));
    const x = Math.floor(clamp(Math.round(raw.x), 0, Math.max(0, width - w)) / 2) * 2;
    const y = Math.floor(clamp(Math.round(raw.y), 0, Math.max(0, height - h)) / 2) * 2;
    return { width: w, height: h, x, y };
  };

  const top = sanitizeCrop(config.topCrop);
  const bottom = sanitizeCrop(config.bottomCrop);
  if (top === null || bottom === null) return null;

  // eslint-disable-next-line security/detect-object-injection -- closed enum (ClipAspect)
  const shape = CLIP_ASPECTS[aspect];
  const ratio = (shape.width * 2) / shape.height;
  const targetHeight = floorEven(
    Math.min(
      typeof options.maxHeight === "number" && Number.isFinite(options.maxHeight)
        ? options.maxHeight
        : MAX_CLIP_HEIGHT,
      MAX_CLIP_HEIGHT,
    ),
  );
  const halfHeight = floorEven(targetHeight / 2);
  const halfWidth = even(halfHeight * ratio);

  return {
    source: { width, height },
    crops: [top, bottom],
    half: { width: halfWidth, height: halfHeight },
    output: { width: halfWidth, height: halfHeight * 2 },
    dividerColor: sanitizeDividerColor(config.dividerColor),
    activeSpeakerHighlight: config.activeSpeakerHighlight ?? false,
  };
}

/**
 * Build the FFmpeg dual-stack filtergraph with a 2px aesthetic divider line
 * between the top and bottom speaker panes (Pillar 3 §02 §4.1).
 */
export function splitScreenFilter(
  frame: StackedFrame,
  options: { readonly dividerColor?: string; readonly dividerHeight?: number } = {},
): string {
  const { source, crops, half, output } = frame;
  const rawColor =
    options.dividerColor ??
    ("dividerColor" in frame && typeof (frame as SplitScreenFrame).dividerColor === "string"
      ? (frame as SplitScreenFrame).dividerColor
      : "black@0.6");
  const color = sanitizeDividerColor(rawColor);
  const divHeight = Math.max(1, Math.min(8, Math.round(options.dividerHeight ?? 2)));
  const divY = Math.max(0, half.height - Math.floor(divHeight / 2));

  const paneChain = (crop: ClipFrame["crop"]): string =>
    [
      `crop=w=${String(crop.width)}:h=${String(crop.height)}:x=${String(crop.x)}:y=${String(crop.y)}`,
      `scale=${String(half.width)}:${String(half.height)}:flags=bicubic`,
      "setsar=1",
    ].join(",");

  return [
    `scale=${String(source.width)}:${String(source.height)},split=2[top_in][bottom_in]`,
    `[top_in]${paneChain(crops[0])}[top]`,
    `[bottom_in]${paneChain(crops[1])}[bottom]`,
    `[top][bottom]vstack=inputs=2[stacked]`,
    `[stacked]drawbox=y=${String(divY)}:color=${color}:width=${String(output.width)}:height=${String(divHeight)}:t=fill,setsar=1,format=yuv420p`,
  ].join(";");
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


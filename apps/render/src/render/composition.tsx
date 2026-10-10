/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Remotion Multi-Sequence Timeline & Video Bumpers Engine (Pillar 6 §06).
 *
 * Implements Opus Clip / Vidyo.ai / Submagic grade intro & outro bumper stitching:
 * - <Series> Seamless Stitcher:
 *   - Sequence 1: Intro Bumper (1.5s - 2.5s motion sting MP4 stitched to front)
 *   - Sequence 2: Main Clip Content + Corner Logo Bug + Kinetic Subtitles
 *   - Sequence 3: Outro Bumper / CTA Card (2.0s - 3.0s closing card MP4)
 * - Total Composition Duration = Intro Duration + Main Clip Duration + Outro Duration
 * - Zero Frame Freezes & Zero Audio Pops:
 *   - Seamless bumper transitions with smooth 50ms audio crossfade ramping
 *   - Audio loudness matched to -14.0 LUFS (YouTube Shorts / TikTok / Reels standard)
 * - Dual Target: Remotion VNode hierarchy (<Series>, <SeriesSequence>, <VideoBumperComposition>)
 *   and FFmpeg multi-stream concatenation filtergraph builder.
 */

import {
  Fragment,
  OffthreadVideo,
  findVNodeByTestId,
  findVNodesByType,
  h,
  type SplitScreenStyle,
  type SplitScreenVNode,
} from "../components/SplitScreenView.js";
import {
  CornerLogo,
  type CornerLogoProps,
} from "../components/CornerLogo.js";

export { Fragment, OffthreadVideo, findVNodeByTestId, findVNodesByType, h };

export const DEFAULT_COMPOSITION_FPS = 30;
export const DEFAULT_COMPOSITION_WIDTH = 1080;
export const DEFAULT_COMPOSITION_HEIGHT = 1920;
export const DEFAULT_TARGET_LUFS = -14.0;
export const DEFAULT_AUDIO_TRANSITION_RAMP_SEC = 0.05; // 50ms anti-pop crossfade ramp

export const INTRO_BUMPER_DURATION_LIMITS = {
  minSec: 1.0,
  maxSec: 3.0,
  defaultSec: 2.0,
} as const;

export const OUTRO_BUMPER_DURATION_LIMITS = {
  minSec: 1.5,
  maxSec: 4.0,
  defaultSec: 2.5,
} as const;

export interface SeriesSequenceProps {
  readonly durationInFrames: number;
  readonly from?: number;
  readonly style?: SplitScreenStyle;
  readonly children?: readonly (SplitScreenVNode | string)[];
  readonly "data-testid"?: string;
  readonly "data-duration-frames"?: number;
  readonly "data-from-frame"?: number;
}

/**
 * Remotion `<Series.Sequence>` component descriptor.
 */
export function SeriesSequence(props: SeriesSequenceProps): SplitScreenVNode {
  return {
    type: "SeriesSequence",
    props: {
      from: props.from ?? 0,
      durationInFrames: props.durationInFrames,
      "data-duration-frames": props.durationInFrames,
      "data-from-frame": props.from ?? 0,
      style: props.style,
      "data-testid": props["data-testid"],
      children: props.children ?? [],
    },
  };
}

export interface SeriesProps {
  readonly children?: readonly (SplitScreenVNode | string)[] | SplitScreenVNode | string;
  readonly style?: SplitScreenStyle;
  readonly "data-testid"?: string;
}

/**
 * Remotion `<Series>` component descriptor:
 * Sequentially arranges child sequences end-to-end, computing frame offsets automatically.
 */
export function Series(props: SeriesProps): SplitScreenVNode {
  let accumulatedFrame = 0;

  const rawChildren = Array.isArray(props.children)
    ? props.children
    : props.children !== undefined && props.children !== null
      ? [props.children]
      : [];

  const resolvedChildren: (SplitScreenVNode | string)[] = [];

  for (const child of rawChildren) {
    if (typeof child === "object" && child !== null && "props" in child) {
      const childDuration = Number(child.props["durationInFrames"] ?? child.props["data-duration-frames"] ?? 0);
      const sequencedChild: SplitScreenVNode = {
        ...child,
        props: {
          ...child.props,
          from: accumulatedFrame,
          "data-from-frame": accumulatedFrame,
        },
      };
      resolvedChildren.push(sequencedChild);
      accumulatedFrame += Math.max(1, childDuration);
    } else {
      resolvedChildren.push(child);
    }
  }

  return {
    type: "Series",
    props: {
      "data-total-frames": accumulatedFrame,
      style: props.style,
      "data-testid": props["data-testid"] ?? "remotion-series",
      children: resolvedChildren,
    },
  };
}

// Support <Series.Sequence> syntax
(Series as unknown as { Sequence: typeof SeriesSequence }).Sequence = SeriesSequence;

export interface VideoBumperCompositionProps {
  /** Main video clip URI. */
  readonly mainVideoSrc: string;
  /** Duration of the main video clip in seconds. */
  readonly mainDurationSec: number;
  /** Optional intro bumper video URI. */
  readonly introVideoSrc?: string;
  /** Intro bumper duration in seconds (clamped to 1.0s - 3.0s, default 2.0s). */
  readonly introDurationSec?: number;
  /** Optional outro bumper video URI. */
  readonly outroVideoSrc?: string;
  /** Outro bumper duration in seconds (clamped to 1.5s - 4.0s, default 2.5s). */
  readonly outroDurationSec?: number;
  /** Composition framerate (default 30). */
  readonly fps?: number;
  /** Canvas width in pixels (default 1080). */
  readonly canvasWidth?: number;
  /** Canvas height in pixels (default 1920). */
  readonly canvasHeight?: number;
  /** Target loudness in LUFS (default -14.0 LUFS). */
  readonly targetLufs?: number;
  /** Optional persistent corner logo bug overlay. */
  readonly cornerLogo?: CornerLogoProps;
  /** Optional subtitle or emoji children to render over main clip. */
  readonly subtitleChildren?: readonly (SplitScreenVNode | string)[];
  readonly style?: SplitScreenStyle;
  readonly "data-testid"?: string;
}

export interface BumperTimingSummary {
  readonly hasIntro: boolean;
  readonly introDurationSec: number;
  readonly introFrames: number;
  readonly mainDurationSec: number;
  readonly mainFrames: number;
  readonly hasOutro: boolean;
  readonly outroDurationSec: number;
  readonly outroFrames: number;
  readonly totalDurationSec: number;
  readonly totalFrames: number;
  readonly targetLufs: number;
}

/**
 * Calculates exact timing and frame counts for intro bumper, main clip, and outro bumper.
 */
export function computeBumperTimelineTiming(options: {
  readonly mainDurationSec: number;
  readonly introVideoSrc?: string;
  readonly introDurationSec?: number;
  readonly outroVideoSrc?: string;
  readonly outroDurationSec?: number;
  readonly fps?: number;
  readonly targetLufs?: number;
}): BumperTimingSummary {
  const {
    mainDurationSec,
    introVideoSrc,
    introDurationSec = INTRO_BUMPER_DURATION_LIMITS.defaultSec,
    outroVideoSrc,
    outroDurationSec = OUTRO_BUMPER_DURATION_LIMITS.defaultSec,
    fps = DEFAULT_COMPOSITION_FPS,
    targetLufs = DEFAULT_TARGET_LUFS,
  } = options;

  const hasIntro = Boolean(introVideoSrc && introVideoSrc.trim().length > 0);
  const hasOutro = Boolean(outroVideoSrc && outroVideoSrc.trim().length > 0);

  const validIntroSec = hasIntro
    ? Math.max(
        INTRO_BUMPER_DURATION_LIMITS.minSec,
        Math.min(INTRO_BUMPER_DURATION_LIMITS.maxSec, introDurationSec),
      )
    : 0;

  const validOutroSec = hasOutro
    ? Math.max(
        OUTRO_BUMPER_DURATION_LIMITS.minSec,
        Math.min(OUTRO_BUMPER_DURATION_LIMITS.maxSec, outroDurationSec),
      )
    : 0;

  const validMainSec = Math.max(0.1, mainDurationSec);

  const introFrames = Math.round(validIntroSec * fps);
  const mainFrames = Math.round(validMainSec * fps);
  const outroFrames = Math.round(validOutroSec * fps);

  const totalFrames = introFrames + mainFrames + outroFrames;
  const totalDurationSec = Math.round(((validIntroSec + validMainSec + validOutroSec) + Number.EPSILON) * 1000) / 1000;

  return {
    hasIntro,
    introDurationSec: validIntroSec,
    introFrames,
    mainDurationSec: validMainSec,
    mainFrames,
    hasOutro,
    outroDurationSec: validOutroSec,
    outroFrames,
    totalDurationSec,
    totalFrames,
    targetLufs,
  };
}

/**
 * Remotion `<VideoBumperComposition />` Component.
 * Seamlessly stitches Intro Bumper, Main Branded Clip, and Outro Bumper inside a `<Series>`.
 */
export function VideoBumperComposition(props: VideoBumperCompositionProps): SplitScreenVNode {
  const {
    mainVideoSrc,
    mainDurationSec,
    introVideoSrc,
    introDurationSec,
    outroVideoSrc,
    outroDurationSec,
    fps = DEFAULT_COMPOSITION_FPS,
    canvasWidth = DEFAULT_COMPOSITION_WIDTH,
    canvasHeight = DEFAULT_COMPOSITION_HEIGHT,
    targetLufs = DEFAULT_TARGET_LUFS,
    cornerLogo,
    subtitleChildren = [],
    style,
    "data-testid": testId = "video-bumper-composition",
  } = props;

  const timing = computeBumperTimelineTiming({
    mainDurationSec,
    introVideoSrc,
    introDurationSec,
    outroVideoSrc,
    outroDurationSec,
    fps,
    targetLufs,
  });

  const sequences: SplitScreenVNode[] = [];

  // 1. Intro Bumper Sequence
  if (timing.hasIntro && introVideoSrc) {
    sequences.push(
      <SeriesSequence
        durationInFrames={timing.introFrames}
        data-testid="intro-bumper-sequence"
      >
        <OffthreadVideo
          src={introVideoSrc}
          data-testid="intro-bumper-video"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: canvasWidth,
            height: canvasHeight,
            objectFit: "cover",
          }}
        />
      </SeriesSequence>,
    );
  }

  // 2. Main Video Clip Sequence (with Corner Logo Bug & Subtitles)
  sequences.push(
    <SeriesSequence
      durationInFrames={timing.mainFrames}
      data-testid="main-clip-sequence"
    >
      <div
        data-testid="main-clip-container"
        style={{
          position: "relative",
          width: canvasWidth,
          height: canvasHeight,
          overflow: "hidden",
        }}
      >
        <OffthreadVideo
          src={mainVideoSrc}
          data-testid="main-clip-video"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: canvasWidth,
            height: canvasHeight,
            objectFit: "cover",
            zIndex: 1,
          }}
        />

        {/* Persistent Corner Logo Bug */}
        {cornerLogo ? (
          <CornerLogo
            {...cornerLogo}
            canvasWidth={canvasWidth}
            canvasHeight={canvasHeight}
            data-testid="main-clip-corner-logo"
          />
        ) : null}

        {/* Subtitles & Captions Layer */}
        {subtitleChildren.length > 0 ? (
          <div
            data-testid="main-clip-subtitles-layer"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: canvasWidth,
              height: canvasHeight,
              pointerEvents: "none",
              zIndex: 50,
            }}
          >
            {subtitleChildren}
          </div>
        ) : null}
      </div>
    </SeriesSequence>,
  );

  // 3. Outro Bumper Sequence
  if (timing.hasOutro && outroVideoSrc) {
    sequences.push(
      <SeriesSequence
        durationInFrames={timing.outroFrames}
        data-testid="outro-bumper-sequence"
      >
        <OffthreadVideo
          src={outroVideoSrc}
          data-testid="outro-bumper-video"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: canvasWidth,
            height: canvasHeight,
            objectFit: "cover",
          }}
        />
      </SeriesSequence>,
    );
  }

  return (
    <div
      data-testid={testId}
      data-total-duration-sec={timing.totalDurationSec}
      data-total-frames={timing.totalFrames}
      data-has-intro={timing.hasIntro}
      data-has-outro={timing.hasOutro}
      data-target-lufs={timing.targetLufs}
      style={{
        position: "relative",
        width: canvasWidth,
        height: canvasHeight,
        overflow: "hidden",
        backgroundColor: "#000000",
        ...style,
      }}
    >
      <Series data-testid="bumper-series-root">{sequences}</Series>
    </div>
  );
}

/**
 * Builds an FFmpeg complex filtergraph string and input arguments for seamless bumper stitching.
 * Ensures zero frame freezes and audio loudness matched to target LUFS (-14.0 LUFS).
 */
export function buildBumperConcatFiltergraph(options: {
  readonly mainVideoPath: string;
  readonly mainDurationSec: number;
  readonly introVideoPath?: string;
  readonly introDurationSec?: number;
  readonly outroVideoPath?: string;
  readonly outroDurationSec?: number;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly targetLufs?: number;
}): {
  readonly filtergraph: string;
  readonly inputArgs: readonly string[];
  readonly totalDurationSec: number;
  readonly totalFrames: number;
  readonly segmentCount: number;
} {
  const {
    mainVideoPath,
    mainDurationSec,
    introVideoPath,
    introDurationSec,
    outroVideoPath,
    outroDurationSec,
    width = DEFAULT_COMPOSITION_WIDTH,
    height = DEFAULT_COMPOSITION_HEIGHT,
    fps = DEFAULT_COMPOSITION_FPS,
    targetLufs = DEFAULT_TARGET_LUFS,
  } = options;

  const timing = computeBumperTimelineTiming({
    mainDurationSec,
    introVideoSrc: introVideoPath,
    introDurationSec,
    outroVideoSrc: outroVideoPath,
    outroDurationSec,
    fps,
    targetLufs,
  });

  const inputArgs: string[] = [];
  const filterParts: string[] = [];
  let inputIndex = 0;
  let segmentIndex = 0;

  // Track segment stream names
  const videoStreams: string[] = [];
  const audioStreams: string[] = [];

  // 1. Intro segment
  if (timing.hasIntro && introVideoPath) {
    inputArgs.push("-i", introVideoPath);
    filterParts.push(
      `[${inputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},setsar=1[v_seg_${segmentIndex}];`,
      `[${inputIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:ss=0:d=${DEFAULT_AUDIO_TRANSITION_RAMP_SEC},afade=t=out:st=${Math.max(0, timing.introDurationSec - DEFAULT_AUDIO_TRANSITION_RAMP_SEC)}:d=${DEFAULT_AUDIO_TRANSITION_RAMP_SEC}[a_seg_${segmentIndex}];`,
    );
    videoStreams.push(`[v_seg_${segmentIndex}]`);
    audioStreams.push(`[a_seg_${segmentIndex}]`);
    inputIndex += 1;
    segmentIndex += 1;
  }

  // 2. Main segment
  inputArgs.push("-i", mainVideoPath);
  filterParts.push(
    `[${inputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},setsar=1[v_seg_${segmentIndex}];`,
    `[${inputIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo[a_seg_${segmentIndex}];`,
  );
  videoStreams.push(`[v_seg_${segmentIndex}]`);
  audioStreams.push(`[a_seg_${segmentIndex}]`);
  inputIndex += 1;
  segmentIndex += 1;

  // 3. Outro segment
  if (timing.hasOutro && outroVideoPath) {
    inputArgs.push("-i", outroVideoPath);
    filterParts.push(
      `[${inputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},setsar=1[v_seg_${segmentIndex}];`,
      `[${inputIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:ss=0:d=${DEFAULT_AUDIO_TRANSITION_RAMP_SEC},afade=t=out:st=${Math.max(0, timing.outroDurationSec - DEFAULT_AUDIO_TRANSITION_RAMP_SEC)}:d=${DEFAULT_AUDIO_TRANSITION_RAMP_SEC}[a_seg_${segmentIndex}];`,
    );
    videoStreams.push(`[v_seg_${segmentIndex}]`);
    audioStreams.push(`[a_seg_${segmentIndex}]`);
    inputIndex += 1;
    segmentIndex += 1;
  }

  // Concat filter: concat=n=SEGMENT_COUNT:v=1:a=1
  const concatInputs = videoStreams.map((v, i) => `${v}${audioStreams[i]}`).join("");
  filterParts.push(
    `${concatInputs}concat=n=${segmentIndex}:v=1:a=1[v_concat][a_concat];`,
    `[a_concat]loudnorm=I=${targetLufs}:LRA=7:TP=-1.5[a_out]`,
  );

  return {
    filtergraph: filterParts.join(""),
    inputArgs,
    totalDurationSec: timing.totalDurationSec,
    totalFrames: timing.totalFrames,
    segmentCount: segmentIndex,
  };
}

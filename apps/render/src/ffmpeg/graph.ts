/**
 * The ffmpeg command line, built from a manifest and a timemap.
 *
 * One picture of what runs (the `video` output, the common case):
 *
 * ```
 *  ┌ input 0: the source file ────────────────────────────────────────────────┐
 *  │  [0:v] trim/setpts per retained span ─┐                                  │
 *  │  [0:a] atrim/asetpts per span ──────┐ │                                  │
 *  └─────────────────────────────────────┼─┼──────────────────────────────────┘
 *                                        │ └→ concat(v) → scale → crop → fps ─┐
 *  ┌ input 1: stdin, rawvideo rgba ──────┼────────────────────────────────────┼┐
 *  │  Skia draws one frame per output    │                                    ││
 *  │  instant and writes it here ────────┼──────────────→ [1:v] ──────────────┼┤
 *  └─────────────────────────────────────┼────────────────────────────────────┘│
 *                                        │                          overlay ←──┘
 *                                        └→ concat(a) → aout        ↓
 *                                                            libx264 → mp4
 * ```
 *
 * Three decisions worth stating:
 *
 * 1. **Cuts are `trim` + `concat`, not `select`.** `select` needs an expression
 *    over every frame and leaves the audio to a parallel `aselect` that has to
 *    agree with it; `trim` takes the span list `@montaj/timemap` already
 *    computed and `concat` guarantees video and audio are cut at the same
 *    instants, which is the property captions depend on.
 * 2. **`fps` sits immediately before `overlay`.** The Skia side produces exactly
 *    one frame per output instant `n/fps`; forcing the base to the same rate is
 *    what keeps the two streams frame-aligned after a concat of spans whose
 *    lengths are not whole frames.
 * 3. **The overlay is a second input on a pipe, not a filter.** Nothing is
 *    buffered to disk and the renderer's back-pressure is ffmpeg's own: when the
 *    encoder is behind, the pipe fills and `write()` stops returning true.
 */

import type { CropKeyframe } from "@montaj/render-core";
import { coverScaleCrop, type RenderManifest } from "@montaj/render-manifest";
import type { TimeQuery, TimeSpan } from "@montaj/timemap";

import {
  buildAudioMixPlan,
  type MusicMixCue,
  type SfxMixCue,
  type SpeechRange,
} from "./audio-mix.js";
import { buildDynamicCropFilter } from "./crop-expr.js";

/** Encoders the service can select between; `05 §5.2`'s NVENC hook. */
export const VIDEO_ENCODERS = ["libx264", "h264_nvenc"] as const;
export type VideoEncoder = (typeof VIDEO_ENCODERS)[number];

export function isVideoEncoder(value: unknown): value is VideoEncoder {
  return typeof value === "string" && (VIDEO_ENCODERS as readonly string[]).includes(value);
}

/** Output sample rate for every re-encoded track. */
export const AUDIO_SAMPLE_RATE = 48_000;

export class GraphError extends Error {
  public override readonly name = "GraphError";
  constructor(
    readonly code: "render/unsupported-output" | "render/no-audio-source",
    message: string,
  ) {
    super(message);
  }
}

export interface GraphInput {
  readonly manifest: RenderManifest;
  /** Local path of the decoded source; omitted for an `alpha` output. */
  readonly sourcePath: string | null;
  /** Local path of a replacement audio track, when the manifest asks for one. */
  readonly cleanAudioPath?: string | null;
  /** The source's real dimensions, after rotation, as ffprobe reported them. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Whether the source actually carries an audio stream. */
  readonly sourceHasAudio: boolean;
  /** The timemap's span list; cuts are the spans with zero output width. */
  readonly spans: readonly TimeSpan[];
  readonly outputDurationMs: number;
  readonly outputPath: string;
  /** `libx264` unless the deployment set `RENDER_VIDEO_ENCODER`. */
  readonly encoder: VideoEncoder;
  /** ffmpeg log level; `error` in production, `info` when a render is being chased. */
  readonly logLevel?: string;
  /**
   * B20: accepted zoom/reframe curve, already decoded and remapped onto the
   * output clock (`@montaj/render-core`'s `outputCropKeyframesFromTracks`,
   * called by `render/pipeline.ts` against the manifest's `timemap.keyframes`
   * and its own `timemap`). Empty/omitted renders exactly as before B20 — the
   * dynamic `crop` filter is skipped entirely rather than inserted as a no-op.
   */
  readonly cropKeyframes?: readonly CropKeyframe[];
  /**
   * D04e: accepted `sfx`/`music` cue items, already carrying the local path of
   * their downloaded pack asset (`pipeline.ts` downloads each `storageKey`
   * before the graph is built). Empty/omitted renders exactly as before D04e.
   */
  readonly sfxCues?: readonly SfxMixCue[];
  readonly musicCues?: readonly MusicMixCue[];
  /** Where speech is, on the **source** clock — `audio-mix.ts`'s
   * `speechRangesFromWords` over `payload.projection.words`. Needed only when
   * a cue/bed carries a `duck`/`bedDuck` curve. */
  readonly speechRanges?: readonly SpeechRange[];
  /**
   * The same `TimeMap` `outputCropKeyframesFromTracks` was given — used to
   * remap each cue's `[startMs, endMs)` onto the output clock
   * (`@montaj/timemap`'s `mapRange`), the identical cuts/ripples remap every
   * other accepted-item track already gets. `null`/omitted is the identity
   * map (an unedited render).
   */
  readonly timemap?: TimeQuery | null;
}

export interface GraphPlan {
  readonly args: readonly string[];
  readonly filterGraph: string;
  /** How many RGBA frames the Skia side must write into the pipe. */
  readonly overlayFrames: number;
  readonly outputDurationMs: number;
  /** True when the output carries an audio track. */
  readonly hasAudio: boolean;
  /** Human summary for the log line and for `BENCHMARK.md`. */
  readonly summary: string;
}

/** Seconds with millisecond resolution, the way ffmpeg wants them. */
function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

/** Frames the overlay stream must supply for a given output length. */
export function overlayFrameCount(outputDurationMs: number, fps: number): number {
  return Math.max(1, Math.round((outputDurationMs / 1000) * fps));
}

/**
 * The spans that produce output: everything except a cut.
 *
 * A cut has zero output width by construction (D30), so this is the whole cut
 * list expressed the other way round — which is why the renderer never has to
 * know what a cut *is*.
 */
export function outputBearingSpans(spans: readonly TimeSpan[]): TimeSpan[] {
  return spans.filter((span) => span.outputEnd > span.outputStart);
}

/**
 * True when the timeline is one uninterrupted, unretimed run of the source.
 *
 * Worth detecting: it lets the graph drop `trim`/`concat` entirely, which is
 * both faster and one less place for a rounding error at a span boundary.
 */
export function isUnedited(spans: readonly TimeSpan[]): boolean {
  const bearing = outputBearingSpans(spans);
  return (
    bearing.length <= 1 && bearing.every((span) => span.kind === "retained" && span.factor === 1)
  );
}

interface CutList {
  readonly parts: string[];
  readonly videoLabel: string;
  readonly audioLabel: string | null;
}

/**
 * `trim`/`atrim` per span, then one `concat`.
 *
 * A freeze frame is the interesting case: it has zero source width, so there is
 * nothing to trim. One frame is taken at the held instant and `loop`ed for the
 * span's output length, and the audio side gets the same length of silence —
 * without it `concat` would refuse the segment for having no audio.
 */
function buildCutList(input: GraphInput, withAudio: boolean): CutList {
  const fps = input.manifest.output.fps;
  const bearing = outputBearingSpans(input.spans);

  if (isUnedited(input.spans)) {
    return { parts: [], videoLabel: "0:v", audioLabel: withAudio ? "0:a" : null };
  }

  const parts: string[] = [];
  const videoLabels: string[] = [];
  const audioLabels: string[] = [];

  for (const [index, span] of bearing.entries()) {
    const v = `v${String(index)}`;
    const a = `a${String(index)}`;
    if (span.kind === "hold") {
      const holdMs = span.outputEnd - span.outputStart;
      const frames = overlayFrameCount(holdMs, fps);
      parts.push(
        `[0:v]trim=start=${seconds(span.sourceStart)}:duration=${(1 / fps).toFixed(6)},` +
          `setpts=PTS-STARTPTS,loop=loop=${String(frames - 1)}:size=1:start=0,` +
          `setpts=N/${String(fps)}/TB[${v}]`,
      );
      if (withAudio) {
        parts.push(
          `anullsrc=r=${String(AUDIO_SAMPLE_RATE)}:cl=stereo,` +
            `atrim=duration=${seconds(holdMs)},asetpts=PTS-STARTPTS[${a}]`,
        );
      }
    } else {
      const retime =
        span.factor === 1 ? "setpts=PTS-STARTPTS" : `setpts=(PTS-STARTPTS)/${String(span.factor)}`;
      parts.push(
        `[0:v]trim=start=${seconds(span.sourceStart)}:end=${seconds(span.sourceEnd)},${retime}[${v}]`,
      );
      if (withAudio) {
        const tempo = span.factor === 1 ? "" : `,atempo=${String(span.factor)}`;
        parts.push(
          `[0:a]atrim=start=${seconds(span.sourceStart)}:end=${seconds(span.sourceEnd)},` +
            `asetpts=PTS-STARTPTS${tempo}[${a}]`,
        );
      }
    }
    videoLabels.push(`[${v}]`);
    if (withAudio) audioLabels.push(`[${a}]`);
  }

  const count = videoLabels.length;
  if (withAudio) {
    parts.push(
      `${interleave(videoLabels, audioLabels)}concat=n=${String(count)}:v=1:a=1[cutv][cuta]`,
    );
    return { parts, videoLabel: "cutv", audioLabel: "cuta" };
  }
  parts.push(`${videoLabels.join("")}concat=n=${String(count)}:v=1:a=0[cutv]`);
  return { parts, videoLabel: "cutv", audioLabel: null };
}

/** `concat` wants `[v0][a0][v1][a1]…`, not all the video then all the audio. */
function interleave(video: readonly string[], audio: readonly string[]): string {
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  return video.map((label, index) => `${label}${audio[index] ?? ""}`).join("");
}

/** `scale` + `crop` + `setsar` for the preset, or nothing when it already fits. */
function buildFit(input: GraphInput): string {
  const { width, height } = input.manifest.output;
  const fit = coverScaleCrop(input.sourceWidth, input.sourceHeight, width, height);
  if (fit.identity) return "setsar=1";
  return (
    `scale=${String(fit.scaleWidth)}:${String(fit.scaleHeight)}:flags=bicubic,` +
    `crop=${String(fit.cropWidth)}:${String(fit.cropHeight)}:${String(fit.cropX)}:${String(fit.cropY)},` +
    `setsar=1`
  );
}

/** Codec flags for the requested container and codec. */
function videoCodecArgs(input: GraphInput): string[] {
  const { output } = input.manifest;
  switch (output.videoCodec) {
    case "h264": {
      const crf = output.crf ?? (output.width >= 2160 || output.height >= 2160 ? 18 : 20);
      if (input.encoder === "h264_nvenc") {
        // The NVENC hook of `05 §5.2`: constant-quality VBR is the closest thing
        // to a CRF, and `p4` is NVENC's own "veryfast"-equivalent preset.
        return [
          "-c:v",
          "h264_nvenc",
          "-preset",
          "p4",
          "-rc",
          "vbr",
          "-cq",
          String(crf),
          "-b:v",
          "0",
          "-pix_fmt",
          "yuv420p",
        ];
      }
      return [
        "-c:v",
        "libx264",
        "-preset",
        output.encoderPreset ?? "veryfast",
        "-crf",
        String(crf),
        "-pix_fmt",
        "yuv420p",
      ];
    }
    case "prores4444":
      // Profile 4444 with a 10-bit YUVA pixel format is the only ProRes flavour
      // that carries alpha, which is the entire point of the alpha export.
      return ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"];
    case "vp9":
      return [
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        "-b:v",
        "0",
        "-crf",
        String(input.manifest.output.crf ?? 30),
        "-row-mt",
        "1",
      ];
    default: {
      const exhaustive: never = output.videoCodec;
      throw new GraphError(
        "render/unsupported-output",
        `no encoder for video codec ${String(exhaustive)}`,
      );
    }
  }
}

function audioCodecArgs(manifest: RenderManifest, canCopy: boolean): string[] {
  if (manifest.audio.strategy === "none") return ["-an"];
  if (manifest.audio.codec === "copy" && canCopy) return ["-c:a", "copy"];
  if (manifest.audio.codec === "pcm") {
    return ["-c:a", "pcm_s16le", "-ar", String(AUDIO_SAMPLE_RATE)];
  }
  if (manifest.audio.codec === "opus") {
    return [
      "-c:a",
      "libopus",
      "-b:a",
      `${String(manifest.audio.bitrateKbps)}k`,
      "-ar",
      String(AUDIO_SAMPLE_RATE),
    ];
  }
  return [
    "-c:a",
    "aac",
    "-b:a",
    `${String(manifest.audio.bitrateKbps)}k`,
    "-ar",
    String(AUDIO_SAMPLE_RATE),
  ];
}

function containerArgs(manifest: RenderManifest): string[] {
  // `+faststart` moves the moov atom to the front so a download plays before it
  // finishes; it costs one extra pass over the file and is worth it every time.
  return manifest.output.container === "mp4" || manifest.output.container === "mov"
    ? ["-movflags", "+faststart"]
    : [];
}

/**
 * Builds the whole command line.
 *
 * @throws {GraphError} when the manifest asks for something the graph cannot
 * express — an audio strategy with no source for it, or a codec/container pair
 * that cannot carry alpha.
 */
export function buildFfmpegArgs(input: GraphInput): GraphPlan {
  const { manifest } = input;
  const { output, audio } = manifest;
  const fps = output.fps;
  const overlayFrames = overlayFrameCount(input.outputDurationMs, fps);

  if (output.kind === "alpha" && output.videoCodec === "h264") {
    throw new GraphError(
      "render/unsupported-output",
      "an alpha export needs ProRes 4444 or VP9; H.264 has no alpha channel",
    );
  }
  if (output.kind !== "alpha" && input.sourcePath === null && output.kind !== "greenscreen") {
    throw new GraphError(
      "render/unsupported-output",
      "a video render needs a decoded source; only alpha and green-screen outputs render without one",
    );
  }

  const wantsAudio = audio.strategy !== "none";
  const replacing = audio.strategy === "replace";
  if (replacing && (input.cleanAudioPath ?? null) === null) {
    throw new GraphError(
      "render/no-audio-source",
      "the manifest asks for a replaced audio track but no cleaned audio was supplied",
    );
  }
  // A source with no audio stream is not an error: it is a silent clip, and the
  // output simply has no audio track either.
  const hasAudio = wantsAudio && (replacing || input.sourceHasAudio);

  const args: string[] = ["-hide_banner", "-nostdin", "-loglevel", input.logLevel ?? "error", "-y"];

  const filters: string[] = [];
  let videoLabel: string;
  let audioLabel: string | null = null;

  if (output.kind === "alpha") {
    // No source picture at all: the caption layer *is* the output.
    args.push(
      "-f",
      "rawvideo",
      "-pixel_format",
      "rgba",
      "-video_size",
      `${String(output.width)}x${String(output.height)}`,
      "-framerate",
      String(fps),
      "-i",
      "pipe:0",
    );
    if (hasAudio) {
      args.push("-i", replacing ? (input.cleanAudioPath ?? "") : (input.sourcePath ?? ""));
      audioLabel = "1:a";
    }
    videoLabel = "0:v";
  } else if (output.kind === "greenscreen") {
    // A solid chroma ground for an editor that cannot key alpha (`03 F-502`).
    args.push(
      "-f",
      "rawvideo",
      "-pixel_format",
      "rgba",
      "-video_size",
      `${String(output.width)}x${String(output.height)}`,
      "-framerate",
      String(fps),
      "-i",
      "pipe:0",
    );
    if (hasAudio) {
      args.push("-i", replacing ? (input.cleanAudioPath ?? "") : (input.sourcePath ?? ""));
      audioLabel = "1:a";
    }
    filters.push(
      `color=c=${output.chromaKey ?? "#00b140"}:s=${String(output.width)}x${String(output.height)}:` +
        `r=${String(fps)}:d=${seconds(input.outputDurationMs)}[ground]`,
    );
    filters.push(`[ground][0:v]overlay=x=0:y=0:eof_action=pass:format=auto[vout]`);
    videoLabel = "vout";
  } else {
    args.push("-i", input.sourcePath ?? "");
    args.push(
      "-f",
      "rawvideo",
      "-pixel_format",
      "rgba",
      "-video_size",
      `${String(output.width)}x${String(output.height)}`,
      "-framerate",
      String(fps),
      "-i",
      "pipe:0",
    );
    if (replacing) args.push("-i", input.cleanAudioPath ?? "");

    const cuts = buildCutList(input, hasAudio && !replacing);
    filters.push(...cuts.parts);
    // B20: the dynamic zoom/reframe crop runs on the post-cut, still
    // full-source-resolution video — `t` in its expressions is exactly the
    // output clock at this point, because `cuts.videoLabel` is already the
    // concatenated (spliced) stream. It has to run *before* `buildFit`'s
    // cover-fit crop, which changes the coordinate space to the output
    // aspect; composing the two is a straight filter chain, not a merged
    // transform, because ffmpeg filters apply pixel-for-pixel in sequence.
    const dynamicCrop = buildDynamicCropFilter(
      input.cropKeyframes ?? [],
      input.sourceWidth,
      input.sourceHeight,
    );
    if (dynamicCrop === null) {
      filters.push(`[${cuts.videoLabel}]${buildFit(input)},fps=${String(fps)}[base]`);
    } else {
      // A dynamic crop's window is the review UI's chosen composition (already
      // at, or proportioned to, the output aspect — CONTRACTS §2 `zoom`/
      // `reframe` items pick their `target`/crop rect with the project's
      // aspect in mind), so unlike the static path this skips `buildFit`'s
      // own cover-fit crop and just scales the cropped, dynamically-sized
      // frame to fill the output — the same choice
      // `apps/web/lib/export/engine.ts` makes (stretching the crop window's
      // fraction of the frame to the output canvas). Composing a *second*,
      // static cover-fit crop on top of a per-frame varying-size crop is not
      // expressible as one ffmpeg `scale`/`crop` pair and was out of reach in
      // this pass — reported as an open question in the final report.
      const { width, height } = input.manifest.output;
      filters.push(
        `[${cuts.videoLabel}]${dynamicCrop},` +
          `scale=${String(width)}:${String(height)}:flags=bicubic,setsar=1,` +
          `fps=${String(fps)}[base]`,
      );
    }
    filters.push(`[base][1:v]overlay=x=0:y=0:eof_action=pass:format=auto[vout]`);
    videoLabel = "vout";
    audioLabel = replacing ? "2:a" : cuts.audioLabel;
  }

  // D04e: mix accepted sfx/music cues into whatever dialogue bus this render
  // already has. `wantsAudio` (not `hasAudio`) gates it: a silent source with
  // cues to play still gets an audio track (an `anullsrc` bed under them),
  // which `hasAudio` alone would not let through.
  const sfxCues = input.sfxCues ?? [];
  const musicCues = input.musicCues ?? [];
  let outputHasAudio = hasAudio;
  if (wantsAudio && (sfxCues.length > 0 || musicCues.length > 0)) {
    const inputCountSoFar = args.filter((arg) => arg === "-i").length;
    const mixPlan = buildAudioMixPlan({
      dialogueLabel: hasAudio ? audioLabel : null,
      sfxCues,
      musicCues,
      timemap: input.timemap ?? null,
      speechRanges: input.speechRanges ?? [],
      outputDurationMs: input.outputDurationMs,
      nextInputIndex: inputCountSoFar,
      sampleRate: AUDIO_SAMPLE_RATE,
    });
    if (mixPlan !== null) {
      args.push(...mixPlan.extraInputArgs);
      filters.push(...mixPlan.filters);
      audioLabel = mixPlan.outLabel;
      outputHasAudio = true;
    }
  }

  const filterGraph = filters.join(";");
  if (filterGraph !== "") args.push("-filter_complex", filterGraph);

  args.push("-map", filterGraph === "" ? `${videoLabel}` : `[${videoLabel}]`);
  if (outputHasAudio && audioLabel !== null) {
    args.push("-map", audioLabel.includes(":") ? audioLabel : `[${audioLabel}]`);
  }

  args.push(...videoCodecArgs(input));
  args.push(
    ...audioCodecArgs(
      manifest,
      // A copy is only possible when nothing touched the samples — a mixed
      // cue bus never qualifies, whatever `isUnedited` says about the cuts.
      outputHasAudio && !replacing && audioLabel === "0:a" && isUnedited(input.spans),
    ),
  );
  if (!outputHasAudio) {
    // `audioCodecArgs` only says `-an` for strategy `none`; a silent source
    // needs it too, or ffmpeg looks for a stream that is not mapped.
    if (!args.includes("-an")) args.push("-an");
  }
  args.push("-r", String(fps));
  args.push("-t", seconds(input.outputDurationMs));
  args.push(...containerArgs(manifest));
  args.push(input.outputPath);

  return {
    args,
    filterGraph,
    overlayFrames,
    outputDurationMs: input.outputDurationMs,
    hasAudio: outputHasAudio,
    summary:
      `${output.kind} ${String(output.width)}×${String(output.height)}@${String(fps)} ` +
      `${output.videoCodec} (${input.encoder}) → ${output.container}` +
      `${outputHasAudio ? `, audio ${audio.strategy}/${audio.codec}` : ", no audio"}` +
      `${sfxCues.length + musicCues.length > 0 ? `, ${String(sfxCues.length)} sfx + ${String(musicCues.length)} music cue(s) mixed` : ""}` +
      `, ${String(overlayFrames)} overlay frames`,
  };
}

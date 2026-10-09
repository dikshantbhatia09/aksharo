import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { MediaJobError, transientFailure, unreadableMedia } from "../errors.js";
import { ffprobe, readProbe } from "../ffmpeg/ffprobe.js";
import { FFMPEG_BASE_ARGS, inputArgs, run } from "../ffmpeg/run.js";
import { logger } from "../logger.js";
import { DERIVED_OBJECT_TAGS } from "../storage.js";
import { withWorkspace } from "../workspace.js";
import {
  audiogramArgs,
  audiogramLayout,
  audiogramSize,
  type AudiogramLayout,
} from "./audiogram.js";
import {
  CANVAS_FIT_CENTER_Y_1080P,
  DEFAULT_PIP_BUBBLE_DIAMETER,
  MAX_CLIP_HEIGHT,
  PRESENTATION_FIT_Y,
  blurredFitFilter,
  buildBlurredFitFiltergraph,
  buildBlurredFitVfFiltergraph,
  canvasFitFilter,
  clipFilter,
  clipFrame,
  computeBlurredFitFilterGeometry,
  directorCutFilter,
  dynamicCropExpressions,
  fitFilter,
  fitFrame,
  interpolateTrajectoryAt,
  pipBubbleFilter,
  remotionVideoTransform,
  splitScreenFilter,
  splitScreenFrame,
  stackedFilter,
  stackedFrame,
  toSplitScreenConfig,
  validateBlurredFitAspectRatio,
  type BlurredFitFilterGeometry,
  type BlurredFitFiltergraphOptions,
  type CanvasFitPlacement,
  type ClipAspect,
  type ClipLayoutMode,
  type CropKeyframe,
  type DynamicReframeTrajectory,
  type LayoutCut,
  type PipBubblePlacement,
  type PipBubblePosition,
  type PipWebcamInput,
  type SplitScreenConfig,
  type SplitScreenFrame,
  type StackedPersonInput,
} from "./clip-frame.js";
import { assertKnownClipFields, readAudiogram } from "./clip-payload.js";

import type { ProbeContainer } from "../ffmpeg/ffprobe.js";
import type { JobContext, ProcessorOutcome } from "../runtime.js";

export {
  CANVAS_FIT_CENTER_Y_1080P,
  DEFAULT_PIP_BUBBLE_DIAMETER,
  PRESENTATION_FIT_Y,
  blurredFitFilter,
  buildBlurredFitFiltergraph,
  buildBlurredFitVfFiltergraph,
  canvasFitFilter,
  computeBlurredFitFilterGeometry,
  directorCutFilter,
  dynamicCropExpressions,
  interpolateTrajectoryAt,
  pipBubbleFilter,
  remotionVideoTransform,
  splitScreenFilter,
  splitScreenFrame,
  toSplitScreenConfig,
  validateBlurredFitAspectRatio,
  type BlurredFitFilterGeometry,
  type BlurredFitFiltergraphOptions,
  type CanvasFitPlacement,
  type ClipLayoutMode,
  type CropKeyframe,
  type DynamicReframeTrajectory,
  type LayoutCut,
  type PipBubblePlacement,
  type PipBubblePosition,
  type PipWebcamInput,
  type SplitScreenConfig,
  type SplitScreenFrame,
};

export interface ClipPayload {
  readonly runId: string;
  readonly candidateId: string;
  readonly clipId: string;
  readonly source: { readonly bucket: "s3" | "r2"; readonly key: string };
  readonly sourceDurationMs: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly handleMs: number;
  readonly destination: { readonly bucket: "s3" | "r2"; readonly key: string };
  readonly profile?: {
    readonly container: "mp4";
    readonly videoCodec: "h264";
    readonly audioCodec: "aac";
    readonly maxHeight: number;
  };
  /** Where the window sits across the source; absent means the centre. */
  readonly reframe?: {
    readonly centerX: number;
    readonly centerY?: number;
    readonly basis: "faces" | "centre";
    /**
     * `stacked` (2026-10-01): each of `people` in half of the picture, the
     * first on top (`stackedFrame`). Absent or `single`: one window.
     */
    readonly layout?: "single" | "stacked" | "fit";
    /**
     * Pillar 3 §04 & §05 — Screen Share, Presentation Slide & Blurred Background Fit:
     * `'CROP_FACE'` | `'CANVAS_FIT'` | `'PIP_BUBBLE'` | `'BLURRED_FIT'`.
     */
    readonly layoutMode?: ClipLayoutMode;
    readonly videoLayoutMode?: "CROP_FACE" | "SPLIT_TWO_SPEAKER" | "BLURRED_FIT" | "STREAMER_SPLIT";
    readonly blurredFit?: {
      readonly enabled: boolean;
      readonly blurRadius?: number;
      readonly dimOpacity?: number;
      readonly saturation?: number;
      readonly borderRadius?: number;
      readonly foregroundY?: number;
      readonly captionZoneY?: number;
    };
    readonly pipWebcam?: PipWebcamInput;
    readonly slideY?: number;
    readonly people?: readonly StackedPersonInput[];
    readonly trajectory?: DynamicReframeTrajectory;
    readonly splitScreen?: SplitScreenConfig;
    readonly directorEdl?: readonly LayoutCut[];
  };
  /** The shape to cut (2026-09-29); 9:16 when absent. */
  readonly aspect?: ClipAspect;
  /**
   * The picture to draw for a source with none (2026-10-04, `audiogram.ts`).
   * Unchecked here: {@link readAudiogram} checks it before it is used.
   */
  readonly audiogram?: unknown;
  readonly profileVersion?: string;
  readonly schemaVersion?: number;
  /** Ignored since 2026-09-25 (see {@link processClip}); still a known field. */
  readonly subtitles?: unknown;
}

const RESULT_SCHEMA_VERSION = 1;

/**
 * How long reading the source's header may take.
 *
 * A probe is a few range requests, so the 45-minute encode budget is far too
 * long to wait on one: a store that has not answered in two minutes is a
 * retry, not a job holding its lock for three quarters of an hour.
 */
const SOURCE_PROBE_TIMEOUT_MS = 120_000;

/**
 * How far short of the asked-for length a cut may land and still count.
 *
 * ffmpeg exits 0 when the source stops arriving part way through — the
 * reconnects ran out, or the object ends early — and writes whatever it had.
 * Frame and AAC boundaries account for a few tens of milliseconds, so a second
 * (or a twentieth of a long clip) leaves room for those and still catches a cut
 * that lost a real part of the clip.
 */
const SHORTFALL_TOLERANCE_MS = 1_000;
const SHORTFALL_TOLERANCE_RATIO = 0.05;

/**
 * `media.clip` — cut one selected interval into a short mezzanine MP4.
 *
 * **Clean picture only.** This used to burn the payload's `subtitles` into the
 * video (Arial, white on a black box). The mezzanine is the clip project's
 * primary media, so every caption the editor drew — and every export — landed
 * on top of a second, uneditable set, and the timeline filmstrip showed text on
 * every frame (2026-09-25). Captions belong to the editing document; a
 * payload's `subtitles` (still optional in the contract) is ignored.
 *
 * **Framing and size** (2026-09-26) come from `clip-frame.ts`: the 9:16 window
 * centres on `reframe.centerX` (the API's pick from the source's face track),
 * and the picture is `profile.maxHeight` tall at most, never upscaled. That
 * needs the source's picture size first, so the source is probed before the
 * cut — a few range requests, which also turns a missing object into a clear
 * answer before any encoding starts. A `stacked` payload (2026-10-01) is cut as
 * two windows, one per person, one above the other (`stackedFrame`).
 *
 * **A source with no picture gets one (2026-10-04)** when the payload asks for
 * an `audiogram`: the ground, the artwork and a live waveform of the clip's own
 * audio, drawn at the shape's size (`audiogram.ts`), so the captioned video,
 * the images and a compilation can be made of it like any clip. The result
 * says which picture it is (`picture`), and only when the payload asked, so an
 * API from before never sees the field. A payload naming a field this worker
 * does not know is refused before anything is read (`clip-payload.ts`): the
 * alternative is a clip cut without what it was asked for.
 *
 * **Failures say whether a retry can help.** The source is read through a
 * signed URL, so a refused connection, a 5xx or an expired signature is the
 * network's fault, not the file's, and is retried; a 404 (the object is gone)
 * and a file ffmpeg cannot decode are answered once. See {@link readFailure}.
 */
export async function processClip(context: JobContext): Promise<ProcessorOutcome> {
  const { settings } = context;
  const payload = context.envelope.payload as unknown as ClipPayload;

  if (!payload || !payload.clipId || !payload.destination?.key || !payload.source?.key) {
    throw unreadableMedia("Invalid media.clip payload", "media/unsupported");
  }
  // Before anything is read: a field this worker does not know is something it
  // was asked for and cannot do (`clip-payload.ts`).
  assertKnownClipFields(payload);
  const audiogram = readAudiogram(payload.audiogram, context.envelope.workspaceId);

  if (
    typeof payload.startMs !== "number" ||
    typeof payload.endMs !== "number" ||
    payload.startMs < 0 ||
    payload.endMs <= payload.startMs
  ) {
    throw unreadableMedia(
      `Invalid time range for clip [${String(payload.startMs)}, ${String(payload.endMs)}]`,
      "media/unsupported",
    );
  }

  const maxHeight = payload.profile?.maxHeight ?? MAX_CLIP_HEIGHT;
  if (!Number.isInteger(maxHeight) || maxHeight <= 0) {
    throw unreadableMedia(
      `Invalid media.clip profile height ${String(maxHeight)}`,
      "media/unsupported",
    );
  }

  // The raw store only. A clip's source is its run's source media, which lives
  // in raw like every primary asset (probe, proxy and the renderer read it from
  // there too). This used to fall back to the derived store when signing failed,
  // but signing never looks at the object — it only fails when the store's
  // client does — so the fallback never ran, and a missing object surfaced as
  // an unexplained ffmpeg error instead. The probe below now says so plainly.
  const sourceUrl = await context.raw.presignGet(payload.source.key, settings.sourceUrlTtlSeconds);

  context.report(5, "measuring the source");
  const source = await probeSource(context, sourceUrl);

  // Two people, one above the other, when the API asks for it and the source
  // can be stacked (landscape, a 9:16 or 4:5 cut); one window otherwise. A
  // stack the source cannot make is cut on the dominant speaker
  // (`reframe.centerX`), never failed: the clip matters more than its layout.
  const wantsStack = payload.reframe?.layout === "stacked";
  const wantsFit = payload.reframe?.layout === "fit";
  const splitConfig = payload.reframe?.splitScreen;
  const customSplit =
    source.video === null || splitConfig?.enabled !== true
      ? null
      : splitScreenFrame(source.video, splitConfig, {
          maxHeight,
          ...(payload.aspect === undefined ? {} : { aspect: payload.aspect }),
        });
  const stacked =
    source.video === null || (!wantsStack && customSplit === null)
      ? null
      : (customSplit ??
          stackedFrame(source.video, {
            maxHeight,
            people: payload.reframe?.people ?? [],
            ...(payload.aspect === undefined ? {} : { aspect: payload.aspect }),
          }));
  if (wantsStack && source.video !== null && stacked === null) {
    logger.warn("a stacked cut could not be stacked; cut as one window", {
      clipId: payload.clipId,
      aspect: payload.aspect ?? "9:16",
      source: source.video,
    });
  }
  const fitted =
    source.video === null || !wantsFit || stacked !== null
      ? null
      : fitFrame(source.video, {
          maxHeight,
          ...(payload.aspect === undefined ? {} : { aspect: payload.aspect }),
        });
  const effectiveLayoutMode: ClipLayoutMode | undefined =
    payload.reframe?.layoutMode ??
    (payload.reframe?.videoLayoutMode === "BLURRED_FIT" || payload.reframe?.blurredFit?.enabled === true
      ? "BLURRED_FIT"
      : undefined);
  const effectiveSlideY = payload.reframe?.slideY ?? payload.reframe?.blurredFit?.foregroundY;
  const frame =
    source.video === null || stacked !== null || fitted !== null
      ? null
      : clipFrame(source.video, {
          maxHeight,
          ...(payload.aspect === undefined ? {} : { aspect: payload.aspect }),
          ...(payload.reframe === undefined ? {} : { centerX: payload.reframe.centerX }),
          ...(payload.reframe?.centerY === undefined ? {} : { centerY: payload.reframe.centerY }),
          ...(effectiveLayoutMode === undefined ? {} : { layoutMode: effectiveLayoutMode }),
          ...(payload.reframe?.pipWebcam === undefined
            ? {}
            : { pipWebcam: payload.reframe.pipWebcam }),
          ...(effectiveSlideY === undefined ? {} : { slideY: effectiveSlideY }),
        });
  if (source.video !== null && stacked === null && fitted === null && frame === null) {
    throw unreadableMedia("The source's picture size could not be read.", "media/probe_failed");
  }
  const leadHandleMs = Math.min(payload.handleMs || 0, Math.max(0, payload.startMs));
  const videoFilter =
    customSplit !== null
      ? splitScreenFilter(customSplit)
      : stacked !== null
      ? stackedFilter(stacked)
      : fitted !== null
      ? fitFilter(fitted)
      : frame !== null
      ? clipFilter(frame, payload.reframe?.trajectory, leadHandleMs / 1000)
      : null;

  // An audiogram (2026-10-04): a source with no picture gets one drawn, when
  // the API asked for it (`audiogram.ts`). A source that turns out to have a
  // picture of its own is cut as any video is, and the result says which.
  const drawn = source.video === null ? audiogram : undefined;
  if (audiogram !== undefined && drawn === undefined) {
    logger.warn("an audiogram was asked for a source with a picture; the picture is cut", {
      clipId: payload.clipId,
      source: source.video,
    });
  }
  if (drawn !== undefined && source.audio === null) {
    // `readProbe` refuses a file with neither, so this is only a guard.
    throw unreadableMedia("The source has no sound to draw a waveform of.", "media/no_streams");
  }

  // The worker checks what it is given: a source the probe measured shorter
  // than the payload says caps the tail handle, so `effectiveEndMs` is what the
  // cut really achieved, and a clip that starts after the source ends is
  // refused rather than encoded as nothing.
  const sourceDurationMs =
    source.durationMs > 0
      ? Math.min(payload.sourceDurationMs || source.durationMs, source.durationMs)
      : payload.sourceDurationMs || payload.endMs;
  if (source.durationMs > 0 && payload.startMs >= source.durationMs) {
    throw unreadableMedia(
      `Clip starts at ${String(payload.startMs)} ms, after the source ends at ${String(source.durationMs)} ms`,
      "media/unsupported",
    );
  }

  context.report(10, "preparing clip workspace");

  return withWorkspace("clip", settings.tempDir, async (workspace) => {
    const maxTail = Math.max(0, sourceDurationMs - payload.endMs);
    const tailHandleMs = Math.min(payload.handleMs || 0, maxTail);

    const effectiveStartMs = Math.max(0, payload.startMs - leadHandleMs);
    // Never past the measured end, which the cut cannot reach whatever the
    // payload says. Still after the start: a start at or past the measured end
    // was refused above.
    const effectiveEndMs =
      source.durationMs > 0
        ? Math.min(payload.endMs + tailHandleMs, source.durationMs)
        : payload.endMs + tailHandleMs;
    const clipDurationMs = effectiveEndMs - effectiveStartMs;

    const startSec = (effectiveStartMs / 1000).toFixed(3);
    const durationSec = (clipDurationMs / 1000).toFixed(3);

    const outPath = workspace.path("mezzanine.mp4");

    // The artwork is best effort: an image that is gone or will not decode is
    // left out, and the clip gets the waveform alone - never no clip.
    const artworkUrl =
      drawn?.artwork === undefined ? undefined : await readableArtwork(context, drawn.artwork.key);
    const picture: AudiogramLayout | null =
      drawn === undefined
        ? null
        : audiogramLayout(audiogramSize(payload.aspect ?? "9:16", maxHeight), {
            artwork: artworkUrl !== undefined,
          });

    context.report(25, `cutting clip interval [${startSec}s, ${durationSec}s]`);
    logger.info("cutting mezzanine clip with ffmpeg", {
      clipId: payload.clipId,
      startSec,
      durationSec,
      effectiveStartMs,
      effectiveEndMs,
      framing: payload.reframe?.basis ?? "centre",
      layout: stacked !== null ? "stacked" : fitted !== null ? "fit" : "single",
      crop: stacked?.crops ?? frame?.crop ?? fitted?.fg,
      output: stacked?.output ?? frame?.output ?? fitted?.output,
      ...(picture === null
        ? {}
        : {
            audiogram: {
              size: `${String(picture.width)}x${String(picture.height)}`,
              artwork: artworkUrl !== undefined,
            },
          }),
    });

    // A cut of the source's own picture (or of its sound alone).
    const cutArgs = (): string[] => [
      ...FFMPEG_BASE_ARGS,
      // Errors only, and no status line: the stderr tail is what decides whether
      // a failure is retried (`readFailure`), and ffmpeg's `\r`-separated stats
      // line would otherwise crowd the one line that says why out of it.
      "-loglevel",
      "error",
      "-nostats",
      // BEFORE the input: an input seek, one range request, not a decode of
      // everything up to the clip.
      "-ss",
      startSec,
      // The reconnect options: without them a connection dropped mid-read makes
      // ffmpeg exit 0 with half a clip.
      ...inputArgs(sourceUrl),
      "-t",
      durationSec,
      // Explicit streams. The source's first audio track is the one its
      // transcript was made from, and that transcript is what the clip project
      // is given; `V` skips an attached cover picture. Anything else the
      // container carries (subtitles, data) stays behind.
      ...(videoFilter === null
        ? ["-vn"]
        : [
            "-map",
            "0:V:0",
            "-vf",
            videoFilter,
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "18",
          ]),
      ...(source.audio === null ? ["-an"] : ["-map", "0:a:0", "-c:a", "aac", "-b:a", "192k"]),
      "-sn",
      "-dn",
      "-movflags",
      "+faststart",
      outPath,
    ];

    const args =
      picture !== null && drawn !== undefined
        ? audiogramArgs({
            sourceUrl,
            ...(artworkUrl === undefined ? {} : { artworkUrl }),
            startSec,
            durationSec,
            layout: picture,
            request: drawn,
            outPath,
          })
        : cutArgs();

    // `run` kills its child when the signal fires, but an abort that fired
    // before it started (a shutdown landing while the workspace was being
    // made) is never seen, and the cut would run its whole budget for a worker
    // that is going away.
    if (context.signal.aborted) {
      throw transientFailure("media/cancelled", "The clip was cancelled before the cut started.");
    }

    const execResult = await run(settings.ffmpegPath, args, {
      timeoutMs: settings.ffmpegTimeoutMs,
      signal: context.signal,
    });

    if (execResult.code !== 0) {
      throw readFailure(
        execResult.stderr,
        "ffmpeg could not cut the clip",
        "media/encode_failed",
        sourceUrl,
      );
    }

    context.report(70, "measuring encoded mezzanine");
    const probed = await measureCut(context, outPath, execResult.stderr);

    // The expected length stops where the source does, since a handle cannot
    // run past the end.
    const expectedMs = Math.min(effectiveEndMs, sourceDurationMs) - effectiveStartMs;
    const pictureMissing = (videoFilter !== null || picture !== null) && probed.video === null;
    const pictureWrong =
      picture !== null &&
      probed.video !== null &&
      (probed.video.width !== picture.width || probed.video.height !== picture.height);
    if (cutCameOutShort(probed.durationMs, expectedMs) || pictureMissing || pictureWrong) {
      throw transientFailure(
        "media/encode_incomplete",
        `The cut came out ${String(probed.durationMs)} ms long, expected about ${String(expectedMs)} ms.`,
        { detail: execResult.stderr },
      );
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- RLS-008 (@aksharo/core-pipelines): internal mezzanine output path inside job workspace
    const fileStat = await stat(outPath);
    const sizeBytes = fileStat.size;
    const checksum = await sha256(outPath);

    context.report(85, "uploading mezzanine clip");
    const targetStore = context.derived;
    await targetStore.putFile({
      key: payload.destination.key,
      file: outPath,
      contentType: "video/mp4",
      tags: DERIVED_OBJECT_TAGS,
    });

    context.report(100, "mezzanine clip ready");

    return {
      result: {
        schemaVersion: RESULT_SCHEMA_VERSION,
        clipId: payload.clipId,
        bucket: payload.destination.bucket,
        key: payload.destination.key,
        checksum,
        sizeBytes,
        // Measured, and never 0: `cutCameOutShort` refuses an unknown length.
        durationMs: probed.durationMs,
        effectiveStartMs,
        effectiveEndMs,
        leadHandleMs,
        tailHandleMs,
        hasAudio: probed.audio !== null,
        deduplicated: false,
        // Only when an audiogram was asked for: an API from before them would
        // refuse the field (`MediaClipResultSchema` is strict).
        ...(audiogram === undefined
          ? {}
          : { picture: drawn === undefined ? "source" : "audiogram" }),
      },
    };
  });
}

/** How long reading the artwork's header may take: one small image. */
const ARTWORK_PROBE_TIMEOUT_MS = 30_000;

/**
 * A signed URL for the audiogram's artwork, once ffprobe has read it as an
 * image; `undefined` when it is gone, unreadable or not a picture, which only
 * costs the clip its artwork. A cancellation is not swallowed.
 */
async function readableArtwork(context: JobContext, key: string): Promise<string | undefined> {
  const { settings } = context;
  let url: string;
  try {
    url = await context.derived.presignGet(key, settings.sourceUrlTtlSeconds);
    const probed = readProbe(
      await ffprobe({
        binary: settings.ffprobePath,
        source: url,
        timeoutMs: Math.min(settings.ffmpegTimeoutMs, ARTWORK_PROBE_TIMEOUT_MS),
        signal: context.signal,
      }),
    );
    if (probed.video === null) throw new Error("the artwork has no picture in it");
    return url;
  } catch (error) {
    if (error instanceof MediaJobError && error.code === "media/cancelled") throw error;
    logger.warn("the audiogram's artwork could not be read; the clip is drawn without it", {
      clipId: (context.envelope.payload as unknown as ClipPayload).clipId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * What a failed ffmpeg or ffprobe read of the source means, from the redacted
 * tail of its stderr.
 *
 * - `missing`: the source is not there (a 404 through the signed URL, or no
 *   such file). Retrying reads the same nothing.
 * - `unreadable`: ffmpeg got the bytes and could not make sense of them.
 * - `transient`: everything else — a refused or reset connection, a 5xx, an
 *   expired signature (403; the retry signs a new one), a full disk. This is
 *   also the answer for anything unrecognised, because retrying a file that
 *   was fine costs one attempt and failing one that was fine loses the clip.
 *
 * Network markers are checked before decode ones on purpose: a source that
 * stops arriving mid-read makes the demuxer and the decoders complain about
 * "invalid data" too, and those lines are the symptom, not the cause.
 *
 * `source` is what the tool was asked to read, for {@link namesMissingSource}.
 */
export type ReadFailureKind = "missing" | "unreadable" | "transient";

/** S3's answer, through a signed URL, for a key that is not there. */
const SOURCE_NOT_FOUND = /Server returned 404/i;
const NO_SUCH_FILE = /No such file or directory/i;
/** ffmpeg 6+ names the side that failed to open: "input" or "output". */
const OPENING_INPUT = /Error opening input/i;
const NETWORK_TROUBLE =
  /Server returned (?:5|403)|Connection|timed out|Error reading HTTP|Stream ends prematurely|End of file|I\/O error|Input\/output error|Network is|resolve|Will reconnect|Error number -?\d+ occurred|No space left|Cannot allocate memory|partial file/i;
const UNDECODABLE =
  /Invalid data found when processing input|moov atom not found|Decoder \(.+\) not found|Unknown decoder|does not contain any stream|Could not find codec parameters/i;

export function classifyReadFailure(stderr: string, source = ""): ReadFailureKind {
  if (SOURCE_NOT_FOUND.test(stderr) || namesMissingSource(stderr, source)) return "missing";
  if (NETWORK_TROUBLE.test(stderr)) return "transient";
  if (UNDECODABLE.test(stderr)) return "unreadable";
  return "transient";
}

/**
 * Whether a "No such file or directory" is about the source.
 *
 * ffmpeg says the same words when it cannot open its *output* — the job's
 * workspace was removed under the encode — and that is a local fault a retry
 * clears, not a source gone from storage. ffmpeg 6+ says which side on the
 * line ("Error opening input" / "Error opening output"); ffprobe, and ffmpeg
 * before 6, print the path instead, so a line that starts with the source
 * counts too. In production the source is a signed URL and only the 404 above
 * ever fires; a local path is how the tests read a file.
 */
function namesMissingSource(stderr: string, source: string): boolean {
  return stderr
    .split("\n")
    .some(
      (line) =>
        NO_SUCH_FILE.test(line) &&
        (OPENING_INPUT.test(line) || (source !== "" && line.includes(`${source}: `))),
    );
}

/**
 * The error to throw for a failed read, retryable exactly when it can help.
 *
 * `transientCode` names the step for the operator reading `jobs.error`:
 * `media/source_unavailable` for the probe, `media/encode_failed` for the cut.
 */
export function readFailure(
  stderr: string,
  what: string,
  transientCode: string,
  source = "",
): MediaJobError {
  switch (classifyReadFailure(stderr, source)) {
    case "missing":
      return new MediaJobError(
        "media/source_missing",
        "The source video is no longer in storage.",
        {
          retryable: false,
          reason: "media/unsupported",
          detail: stderr,
        },
      );
    case "unreadable":
      return unreadableMedia(`The source could not be decoded (${what}).`, "media/corrupt", stderr);
    case "transient":
      return transientFailure(transientCode, `${what}.`, { detail: stderr });
  }
}

/**
 * Probe the source through its signed URL.
 *
 * `ffprobe()` reads every non-zero exit as "this file cannot be read", which
 * is right for an upload the probe is judging and wrong here: over a signed
 * URL, a refused connection or a 5xx exits the same way. Its stderr says which.
 */
async function probeSource(context: JobContext, url: string): Promise<ProbeContainer> {
  return probeSourceAt(context, url, SOURCE_PROBE_TIMEOUT_MS);
}

/**
 * {@link probeSource} with its own time limit, for the dub mux (2026-10-04),
 * which reads a clip's picture and a dub's sound through signed URLs the same
 * way and reads back what it wrote.
 */
export async function probeSourceAt(
  context: Pick<JobContext, "settings" | "signal">,
  url: string,
  timeoutMs: number,
): Promise<ProbeContainer> {
  let output;
  try {
    output = await ffprobe({
      binary: context.settings.ffprobePath,
      source: url,
      timeoutMs: Math.min(context.settings.ffmpegTimeoutMs, timeoutMs),
      signal: context.signal,
    });
  } catch (error) {
    // Only the non-zero exit is reread; an unreadable source keeps ffprobe's own
    // answer, as do its timeouts and cancellations (already retryable).
    if (
      error instanceof MediaJobError &&
      error.code === "media/unreadable" &&
      error.reason === "media/unsupported" &&
      classifyReadFailure(error.detail ?? "", url) !== "unreadable"
    ) {
      throw readFailure(
        error.detail ?? "",
        "ffprobe could not read the source",
        "media/source_unavailable",
        url,
      );
    }
    throw error;
  }
  return readProbe(output);
}

/**
 * `run`'s own failures: ffprobe was cancelled, timed out, killed or never
 * started. They say nothing about the file, are retryable already, and keep
 * their code, so a worker stopped mid-measure is not recorded as a short cut.
 */
const TOOL_FAILURES: ReadonlySet<string> = new Set([
  "media/cancelled",
  "media/tool_timeout",
  "media/tool_signal",
  "media/tool_spawn",
]);

/**
 * Probe what the encode wrote.
 *
 * A file ffprobe cannot read is the encode's fault, not the source's — the
 * source already probed clean — so it is retried, with the encode's stderr
 * attached.
 */
async function measureCut(
  context: JobContext,
  file: string,
  encodeStderr: string,
): Promise<ProbeContainer> {
  try {
    return readProbe(
      await ffprobe({
        binary: context.settings.ffprobePath,
        source: file,
        timeoutMs: 15_000,
        signal: context.signal,
      }),
    );
  } catch (error) {
    if (error instanceof MediaJobError && TOOL_FAILURES.has(error.code)) throw error;
    throw transientFailure("media/encode_incomplete", "The cut clip could not be read back.", {
      detail: encodeStderr,
      cause: error,
    });
  }
}

/**
 * Whether a cut that ffmpeg says succeeded is missing part of the clip.
 *
 * ffmpeg exits 0 when the source stops arriving part way through, so only the
 * length of what was written tells. An unknown length (`readProbe`'s 0) counts
 * as short: the cut is an MP4 this worker has just written with its index up
 * front, which always declares one, so a 0 means the file is not whole.
 */
export function cutCameOutShort(measuredMs: number, expectedMs: number): boolean {
  if (measuredMs <= 0) return true;
  const toleranceMs = Math.max(SHORTFALL_TOLERANCE_MS, expectedMs * SHORTFALL_TOLERANCE_RATIO);
  return measuredMs < expectedMs - toleranceMs;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- RLS-008 (@aksharo/core-pipelines): verified local file stream for sha256 checksum calculation
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

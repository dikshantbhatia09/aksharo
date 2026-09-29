import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { MediaJobError, transientFailure, unreadableMedia } from "../errors.js";
import { FFMPEG_BASE_ARGS, inputArgs, run } from "../ffmpeg/run.js";
import { logger } from "../logger.js";
import { DERIVED_OBJECT_TAGS } from "../storage.js";
import { withWorkspace } from "../workspace.js";
import { probeSourceAt, readFailure } from "./clip.js";

import type { ProbeContainer } from "../ffmpeg/ffprobe.js";
import type { JobContext, ProcessorOutcome } from "../runtime.js";

/**
 * `media.dub@1` (2026-10-04), as `@montaj/repurpose-contracts` defines it:
 * one language's dubbed audio laid under one shape's clean video.
 */
export interface DubPayload {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly clipId: string;
  readonly dubId: string;
  readonly language: string;
  readonly shape: DubShape;
  readonly video: { readonly key: string; readonly durationMs: number };
  readonly audio: { readonly key: string };
  readonly destination: { readonly bucket: "s3" | "r2"; readonly key: string };
  /** Keep the clip's own sound under the dub, this many dB down; absent: replace it. */
  readonly originalBedDb?: number;
}

export type DubShape = "9:16" | "4:5" | "1:1" | "16:9";

const SHAPE_SLUG: Readonly<Record<DubShape, string>> = Object.freeze({
  "9:16": "9x16",
  "4:5": "4x5",
  "1:1": "1x1",
  "16:9": "16x9",
});

/*
 * The contract's key patterns (`packages/repurpose-contracts/src/dubbing.ts`),
 * restated because a worker does not import across the app boundary;
 * `dub.test.ts` holds them to the contract's fixtures. A payload is a request,
 * not a fact: the worker reads only a clip's clean video and a dub's audio, and
 * writes only the dub's own video for this language and shape.
 */
const CLIP_VIDEO_KEY =
  /^ws\/([0-9A-HJKMNP-TV-Z]{26})\/p\/[0-9A-HJKMNP-TV-Z]{26}\/repurpose\/[0-9A-HJKMNP-TV-Z]{26}\/clips\/[0-9A-HJKMNP-TV-Z]{26}\/master(?:-(?:4x5|1x1|16x9))?\.mp4$/;
const DUB_AUDIO_KEY =
  /^ws\/([0-9A-HJKMNP-TV-Z]{26})\/p\/[0-9A-HJKMNP-TV-Z]{26}\/repurpose\/[0-9A-HJKMNP-TV-Z]{26}\/dubs\/([0-9A-HJKMNP-TV-Z]{26})\/((?:en|hi|bn|gu|kn|ml|mr|or|pa|ta|te|as)-IN)\/audio\.(?:mp3|wav|m4a|aac|ogg|opus|flac|webm)$/;
const DUB_VIDEO_KEY =
  /^ws\/([0-9A-HJKMNP-TV-Z]{26})\/p\/[0-9A-HJKMNP-TV-Z]{26}\/repurpose\/[0-9A-HJKMNP-TV-Z]{26}\/dubs\/([0-9A-HJKMNP-TV-Z]{26})\/((?:en|hi|bn|gu|kn|ml|mr|or|pa|ta|te|as)-IN)\/(9x16|4x5|1x1|16x9)\.mp4$/;

const RESULT_SCHEMA_VERSION = 1;

/** Within this, the audio is taken as the picture's length: an AAC frame is about 21 ms. */
const EXACT_TOLERANCE_MS = 40;

/** How far a written video may fall short of its picture and still count. */
const SHORTFALL_TOLERANCE_MS = 1_000;

/** Probing a signed URL is a few range requests; a store silent for this long is a retry. */
const PROBE_TIMEOUT_MS = 120_000;

/**
 * `media.dub` — lay one language's dubbed audio under one shape's clean video
 * (2026-10-04).
 *
 * The picture is copied, never re-encoded: it is the shape's clean cut
 * already, and a stream copy of a three-minute clip takes a second where an
 * encode takes minutes. The audio is encoded to AAC and fitted to the
 * picture's length: padded with silence when the dub is shorter, cut when it
 * is longer. How the vendor's dub compares with the source is not known yet,
 * so the fit and how much it moved are reported back (`fit`, `adjustMs`) for
 * the run's record, not guessed at.
 *
 * `originalBedDb` keeps the clip's own sound under the dub at that level. It is
 * for a vendor whose audio turns out to be dialogue only; the default (absent)
 * replaces the sound, which is right when the vendor's audio is the full mix.
 * A clip with no sound of its own is always replaced.
 */
export async function processDub(context: JobContext): Promise<ProcessorOutcome> {
  const { settings } = context;
  const payload = context.envelope.payload as unknown as DubPayload;
  const checked = checkPayload(payload, context.envelope.workspaceId);

  const [videoUrl, audioUrl] = await Promise.all([
    context.derived.presignGet(payload.video.key, settings.sourceUrlTtlSeconds),
    context.derived.presignGet(payload.audio.key, settings.sourceUrlTtlSeconds),
  ]);

  context.report(5, "measuring the picture and the dub");
  const [picture, dub] = await Promise.all([
    probeSourceAt(context, videoUrl, PROBE_TIMEOUT_MS),
    probeSourceAt(context, audioUrl, PROBE_TIMEOUT_MS),
  ]);
  if (picture.video === null) {
    throw unreadableMedia("The clip's video has no picture in it.", "media/unsupported");
  }
  if (dub.audio === null) {
    throw unreadableMedia("The dub has no sound in it.", "media/unsupported");
  }
  const videoMs = picture.durationMs > 0 ? picture.durationMs : payload.video.durationMs;
  const fit = fitOf(dub.durationMs, videoMs);
  const mixed = payload.originalBedDb !== undefined && picture.audio !== null;

  return withWorkspace("dub", settings.tempDir, async (workspace) => {
    const out = workspace.path("dubbed.mp4");
    if (context.signal.aborted) {
      throw transientFailure("media/cancelled", "The dub was cancelled before it was laid.");
    }
    context.report(20, "laying the dub under the picture");
    logger.info("laying a dub under a clip", {
      dubId: payload.dubId,
      clipId: payload.clipId,
      language: checked.language,
      shape: payload.shape,
      videoMs,
      audioMs: dub.durationMs,
      fit: fit.fit,
      adjustMs: fit.adjustMs,
      mixed,
    });
    const result = await run(
      settings.ffmpegPath,
      muxArgs({
        videoUrl,
        audioUrl,
        durationMs: videoMs,
        ...(mixed && payload.originalBedDb !== undefined ? { bedDb: payload.originalBedDb } : {}),
        out,
      }),
      { timeoutMs: settings.ffmpegTimeoutMs, signal: context.signal },
    );
    if (result.code !== 0) {
      throw readFailure(
        result.stderr,
        "ffmpeg could not lay the dub",
        "media/encode_failed",
        videoUrl,
      );
    }

    context.report(75, "measuring the dubbed video");
    const made = await measure(context, out, result.stderr);
    if (
      made.video === null ||
      made.audio === null ||
      made.durationMs <= 0 ||
      made.durationMs < videoMs - SHORTFALL_TOLERANCE_MS
    ) {
      throw transientFailure(
        "media/encode_incomplete",
        `The dubbed video came out ${String(made.durationMs)} ms long, expected about ${String(videoMs)} ms.`,
        { detail: result.stderr },
      );
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the job workspace's own output
    const sizeBytes = (await stat(out)).size;
    const checksum = await sha256(out);
    context.report(85, "storing the dubbed video");
    await context.derived.putFile({
      key: payload.destination.key,
      file: out,
      contentType: "video/mp4",
      tags: DERIVED_OBJECT_TAGS,
    });
    context.report(100, "dubbed video ready");

    return {
      result: {
        schemaVersion: RESULT_SCHEMA_VERSION,
        dubId: payload.dubId,
        clipId: payload.clipId,
        language: checked.language,
        shape: payload.shape,
        key: payload.destination.key,
        checksum,
        sizeBytes,
        durationMs: made.durationMs,
        audioDurationMs: Math.max(0, dub.durationMs),
        fit: fit.fit,
        adjustMs: fit.adjustMs,
        mixed,
      },
    };
  });
}

/**
 * The payload, held to the contract: the three keys in their places, all in
 * the job's own workspace, the audio and the video of the SAME dub and
 * language, the video named for its shape. Nothing here is a transient
 * condition, so a refusal is final.
 */
export function checkPayload(
  payload: DubPayload | undefined,
  workspaceId: string,
): { readonly language: string } {
  const refuse = (why: string): MediaJobError =>
    unreadableMedia(`Invalid media.dub payload: ${why}`, "media/unsupported");
  if (payload === undefined || typeof payload !== "object") throw refuse("no payload");
  const shape = payload.shape;
  if (!Object.hasOwn(SHAPE_SLUG, shape)) throw refuse("unknown shape");
  if (
    typeof payload.video?.durationMs !== "number" ||
    !Number.isFinite(payload.video.durationMs) ||
    payload.video.durationMs <= 0
  ) {
    throw refuse("no picture length");
  }
  if (
    payload.originalBedDb !== undefined &&
    (typeof payload.originalBedDb !== "number" ||
      !Number.isFinite(payload.originalBedDb) ||
      payload.originalBedDb > 0 ||
      payload.originalBedDb < -60)
  ) {
    throw refuse("the original's level is out of range");
  }
  const video = CLIP_VIDEO_KEY.exec(payload.video?.key ?? "");
  const audio = DUB_AUDIO_KEY.exec(payload.audio?.key ?? "");
  const destination = DUB_VIDEO_KEY.exec(payload.destination?.key ?? "");
  if (video === null) throw refuse("the video is not a clip's clean cut");
  if (audio === null) throw refuse("the audio is not a dub's");
  if (destination === null) throw refuse("the destination is not a dub's video");
  if (video[1] !== workspaceId || audio[1] !== workspaceId || destination[1] !== workspaceId) {
    throw refuse("a key is outside the job's workspace");
  }
  if (audio[2] !== payload.dubId || destination[2] !== payload.dubId) {
    throw refuse("a key belongs to another dub");
  }
  if (audio[3] !== payload.language || destination[3] !== payload.language) {
    throw refuse("a key belongs to another language");
  }
  // eslint-disable-next-line security/detect-object-injection -- a checked shape
  if (destination[4] !== SHAPE_SLUG[shape]) throw refuse("the destination is another shape's");
  return { language: payload.language };
}

/** How the dub is fitted to the picture, and by how much. */
export function fitOf(
  audioMs: number,
  videoMs: number,
): { readonly fit: "exact" | "padded" | "trimmed"; readonly adjustMs: number } {
  const difference = Math.round(videoMs - Math.max(0, audioMs));
  if (Math.abs(difference) <= EXACT_TOLERANCE_MS)
    return { fit: "exact", adjustMs: Math.abs(difference) };
  return difference > 0
    ? { fit: "padded", adjustMs: difference }
    : { fit: "trimmed", adjustMs: -difference };
}

/**
 * The ffmpeg arguments: the picture stream-copied, the dub (padded with
 * silence past its end) as the only sound or over the clip's own at `bedDb`,
 * the whole cut to the picture's length.
 */
export function muxArgs(input: {
  readonly videoUrl: string;
  readonly audioUrl: string;
  readonly durationMs: number;
  readonly bedDb?: number;
  readonly out: string;
}): string[] {
  const seconds = (input.durationMs / 1000).toFixed(3);
  const sound =
    input.bedDb === undefined
      ? ["-map", "0:V:0", "-map", "1:a:0", "-af", "apad"]
      : [
          "-filter_complex",
          `[1:a:0]aresample=48000,apad[dub];[0:a:0]aresample=48000,volume=${input.bedDb.toFixed(1)}dB[bed];` +
            "[dub][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]",
          "-map",
          "0:V:0",
          "-map",
          "[mix]",
        ];
  return [
    ...FFMPEG_BASE_ARGS,
    "-loglevel",
    "error",
    "-nostats",
    ...inputArgs(input.videoUrl),
    ...inputArgs(input.audioUrl),
    ...sound,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    // The padded dub never ends by itself: the picture's length does it.
    "-t",
    seconds,
    "-sn",
    "-dn",
    "-movflags",
    "+faststart",
    input.out,
  ];
}

async function measure(context: JobContext, file: string, stderr: string): Promise<ProbeContainer> {
  try {
    return await probeSourceAt(context, file, 15_000);
  } catch (error) {
    if (error instanceof MediaJobError && error.code === "media/cancelled") throw error;
    throw transientFailure("media/encode_incomplete", "The dubbed video could not be read back.", {
      detail: stderr,
      cause: error,
    });
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the job workspace's own output
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

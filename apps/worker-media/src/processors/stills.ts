import { stat } from "node:fs/promises";

import { transientFailure, unreadableMedia } from "../errors.js";
import { FFMPEG_BASE_ARGS, inputArgs, run } from "../ffmpeg/run.js";
import { logger } from "../logger.js";
import { DERIVED_OBJECT_TAGS } from "../storage.js";
import { withWorkspace } from "../workspace.js";
import { readFailure } from "./clip.js";

import type { JobContext, ProcessorOutcome } from "../runtime.js";

/** One image to take: a frame of a video in the derived store, cropped to a size. */
export interface StillRequest {
  /** `carousel-3`, `thumbnail-1`: names the file in the result. */
  readonly name: string;
  /** The video it is taken from (a captioned export or a clean cut), derived store. */
  readonly sourceKey: string;
  readonly atMs: number;
  readonly width: number;
  readonly height: number;
  /**
   * Where the crop sits down a picture taller than the image, 0 (top) to 1;
   * the middle when absent. The API's pick from the face track, so a wide
   * banner keeps the speaker's face rather than their chest.
   */
  readonly focusY?: number;
  /** Where the JPEG is written, derived store. */
  readonly destinationKey: string;
}

export interface StillsPayload {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly clipId: string;
  /** The folder every image goes under; what the runtime's envelope check reads. */
  readonly destination: { readonly bucket: "s3" | "r2"; readonly key: string };
  readonly images: readonly StillRequest[];
  /** Echoed back so the API can tell a result for the videos it has now from an old one. */
  readonly fingerprint?: string;
}

/** The most images one job takes: every image file of a clip, with room to spare. */
export const MAX_STILLS = 40;
/** The largest side an image may ask for (the YouTube banner is 2560). */
const MAX_STILL_SIDE = 4096;

const RESULT_SCHEMA_VERSION = 1;

/**
 * `media.stills` — the image formats of a clip (2026-09-29): posts, carousel
 * slides, pins, thumbnails, covers and banners, each one frame of one of the
 * clip's videos, cropped to its size and written as a JPEG.
 *
 * Every image is its own ffmpeg run with an input seek, so a frame costs one
 * range request and one decode, never a pass over the video. The crop covers
 * the image (the picture is scaled until both sides fit, then cut to size),
 * across the middle and down at `focusY`.
 *
 * A source that is gone is answered once (the API asks again when the videos
 * change); anything else a retry may clear is retried.
 */
export async function processStills(context: JobContext): Promise<ProcessorOutcome> {
  const { settings } = context;
  const payload = context.envelope.payload as unknown as StillsPayload;

  if (
    !payload ||
    !payload.clipId ||
    !Array.isArray(payload.images) ||
    payload.images.length === 0 ||
    payload.images.length > MAX_STILLS
  ) {
    throw unreadableMedia("Invalid media.stills payload", "media/unsupported");
  }
  for (const image of payload.images) {
    if (!validRequest(image)) {
      throw unreadableMedia(
        `Invalid media.stills image ${String(image?.name)}`,
        "media/unsupported",
      );
    }
  }

  return withWorkspace("stills", settings.tempDir, async (workspace) => {
    const made: Record<string, unknown>[] = [];
    const urls = new Map<string, string>();
    let index = 0;
    for (const image of payload.images) {
      if (context.signal.aborted) {
        throw transientFailure("media/cancelled", "The images were cancelled part way through.");
      }
      let url = urls.get(image.sourceKey);
      if (url === undefined) {
        url = await context.derived.presignGet(image.sourceKey, settings.sourceUrlTtlSeconds);
        urls.set(image.sourceKey, url);
      }
      const out = workspace.path(`still-${String(index)}.jpg`);
      const result = await run(settings.ffmpegPath, stillArgs(url, image, out), {
        timeoutMs: Math.min(settings.ffmpegTimeoutMs, 120_000),
        signal: context.signal,
      });
      if (result.code !== 0) {
        throw readFailure(
          result.stderr,
          `ffmpeg could not take the ${image.name} image`,
          "media/encode_failed",
          url,
        );
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- internal path inside the job workspace
      const sizeBytes = (await stat(out).catch(() => null))?.size ?? 0;
      if (sizeBytes === 0) {
        // A seek past the last frame writes nothing and exits 0.
        throw unreadableMedia(
          `The ${image.name} image came out empty (frame at ${String(image.atMs)} ms).`,
          "media/corrupt",
          result.stderr,
        );
      }
      await context.derived.putFile({
        key: image.destinationKey,
        file: out,
        contentType: "image/jpeg",
        tags: DERIVED_OBJECT_TAGS,
      });
      made.push({
        name: image.name,
        key: image.destinationKey,
        width: image.width,
        height: image.height,
        sizeBytes,
        atMs: image.atMs,
      });
      index += 1;
      context.report(Math.round((index / payload.images.length) * 95), `image ${image.name}`);
    }
    logger.info("clip images made", { clipId: payload.clipId, count: made.length });
    context.report(100, "images ready");
    return {
      result: {
        schemaVersion: RESULT_SCHEMA_VERSION,
        clipId: payload.clipId,
        images: made,
        ...(payload.fingerprint === undefined ? {} : { fingerprint: payload.fingerprint }),
      },
    };
  });
}

function validRequest(image: StillRequest | undefined): image is StillRequest {
  if (typeof image !== "object" || image === null) return false;
  const side = (value: unknown): boolean =>
    typeof value === "number" && Number.isInteger(value) && value >= 16 && value <= MAX_STILL_SIDE;
  return (
    typeof image.name === "string" &&
    /^[a-z0-9-]{1,64}$/.test(image.name) &&
    typeof image.sourceKey === "string" &&
    image.sourceKey !== "" &&
    typeof image.destinationKey === "string" &&
    image.destinationKey !== "" &&
    typeof image.atMs === "number" &&
    Number.isFinite(image.atMs) &&
    image.atMs >= 0 &&
    side(image.width) &&
    side(image.height) &&
    (image.focusY === undefined ||
      (typeof image.focusY === "number" && image.focusY >= 0 && image.focusY <= 1))
  );
}

/**
 * The filter that makes one image: scale until the picture covers `width` x
 * `height`, then crop across the middle and down at `focusY`, kept inside the
 * picture. Even sizes are not needed (a JPEG is not 4:2:0-bound here).
 */
export function stillFilter(image: Pick<StillRequest, "width" | "height" | "focusY">): string {
  const { width, height } = image;
  const focus = image.focusY ?? 0.5;
  // Commas inside an expression are escaped so the filtergraph does not read
  // them as the next filter.
  const y = `min(max(ih*${focus.toFixed(4)}-oh/2\\,0)\\,ih-oh)`;
  return [
    `scale=${String(width)}:${String(height)}:force_original_aspect_ratio=increase`,
    `crop=${String(width)}:${String(height)}:(iw-ow)/2:${y}`,
    "setsar=1",
  ].join(",");
}

export function stillArgs(sourceUrl: string, image: StillRequest, out: string): string[] {
  return [
    ...FFMPEG_BASE_ARGS,
    "-loglevel",
    "error",
    "-nostats",
    "-ss",
    (image.atMs / 1000).toFixed(3),
    ...inputArgs(sourceUrl),
    "-map",
    "0:V:0",
    "-frames:v",
    "1",
    "-vf",
    stillFilter(image),
    "-q:v",
    "2",
    "-update",
    "1",
    out,
  ];
}

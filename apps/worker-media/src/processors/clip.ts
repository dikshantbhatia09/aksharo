import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { unreadableMedia } from "../errors.js";
import { ffprobe, readProbe } from "../ffmpeg/ffprobe.js";
import { run } from "../ffmpeg/run.js";
import { logger } from "../logger.js";
import { DERIVED_OBJECT_TAGS } from "../storage.js";
import { withWorkspace } from "../workspace.js";

import type { JobContext, ProcessorOutcome } from "../runtime.js";

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
  readonly profileVersion?: string;
}

const RESULT_SCHEMA_VERSION = 1;

/**
 * `media.clip` — cut one selected interval into a short mezzanine MP4.
 *
 * **Clean picture only.** This used to burn the payload's `subtitles` into the
 * video (Arial, white on a black box). The mezzanine is the clip project's
 * primary media, so every caption the editor drew — and every export — landed
 * on top of a second, uneditable set, and the timeline filmstrip showed text on
 * every frame (2026-09-25). Captions belong to the editing document; a
 * payload's `subtitles` (still optional in the contract) is ignored.
 */
export async function processClip(context: JobContext): Promise<ProcessorOutcome> {
  const { settings } = context;
  const payload = context.envelope.payload as unknown as ClipPayload;

  if (
    !payload ||
    !payload.clipId ||
    !payload.destination?.key ||
    !payload.source?.key
  ) {
    throw unreadableMedia("Invalid media.clip payload", "media/unsupported");
  }

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

  // Get presigned URL for the source (try raw first, fallback to derived)
  let sourceUrl: string;
  try {
    sourceUrl = await context.raw.presignGet(payload.source.key, settings.sourceUrlTtlSeconds);
  } catch {
    try {
      sourceUrl = await context.derived.presignGet(payload.source.key, settings.sourceUrlTtlSeconds);
    } catch {
      throw unreadableMedia(
        `Source object not found: ${payload.source.key}`,
        "media/unsupported",
      );
    }
  }

  if (!sourceUrl.startsWith("http://") && !sourceUrl.startsWith("https://")) {
    const { existsSync } = await import("node:fs");
    if (!existsSync(sourceUrl)) {
      throw unreadableMedia(
        `Source object not found: ${payload.source.key}`,
        "media/unsupported",
      );
    }
  }

  context.report(10, "preparing clip workspace");

  return withWorkspace("clip", settings.tempDir, async (workspace) => {
    const leadHandleMs = Math.min(payload.handleMs || 0, Math.max(0, payload.startMs));
    const maxTail = Math.max(0, (payload.sourceDurationMs || payload.endMs) - payload.endMs);
    const tailHandleMs = Math.min(payload.handleMs || 0, maxTail);

    const effectiveStartMs = Math.max(0, payload.startMs - leadHandleMs);
    const effectiveEndMs = payload.endMs + tailHandleMs;
    const clipDurationMs = effectiveEndMs - effectiveStartMs;

    const startSec = (effectiveStartMs / 1000).toFixed(3);
    const durationSec = (clipDurationMs / 1000).toFixed(3);

    const outPath = workspace.path("mezzanine.mp4");

    context.report(25, `cutting clip interval [${startSec}s, ${durationSec}s]`);
    logger.info("cutting mezzanine clip with ffmpeg", {
      clipId: payload.clipId,
      startSec,
      durationSec,
      effectiveStartMs,
      effectiveEndMs,
    });

    const filters: string[] = ["crop='min(iw,ih*9/16)':'min(ih,iw*16/9)',scale=720:1280,setsar=1"];

    const vfArg = filters.join(",");

    const args = [
      "-nostdin",
      "-y",
      "-ss",
      startSec,
      "-i",
      sourceUrl,
      "-t",
      durationSec,
      ...(vfArg ? ["-vf", vfArg] : []),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outPath,
    ];

    const execResult = await run(settings.ffmpegPath, args, {
      timeoutMs: settings.ffmpegTimeoutMs,
      signal: context.signal,
      onStderr: () => {
        context.report(50, "encoding mezzanine");
      },
    });

    if (execResult.code !== 0) {
      throw unreadableMedia(
        `ffmpeg mezzanine encode failed: ${execResult.stderr.slice(-300)}`,
        "media/probe_failed",
      );
    }

    context.report(70, "measuring encoded mezzanine");
    const rawProbe = await ffprobe({
      binary: settings.ffprobePath,
      source: outPath,
      timeoutMs: 15_000,
      signal: context.signal,
    });
    const probed = readProbe(rawProbe);

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

    const measuredDurationMs = probed.durationMs ?? clipDurationMs;

    return {
      result: {
        schemaVersion: RESULT_SCHEMA_VERSION,
        clipId: payload.clipId,
        bucket: payload.destination.bucket,
        key: payload.destination.key,
        checksum,
        sizeBytes,
        durationMs: measuredDurationMs,
        effectiveStartMs,
        effectiveEndMs,
        leadHandleMs,
        tailHandleMs,
        hasAudio: probed.audio !== null,
        deduplicated: false,
      },
    };
  });
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- RLS-008 (@aksharo/core-pipelines): verified local file stream for sha256 checksum calculation
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

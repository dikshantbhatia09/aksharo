import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { unreadableMedia } from "../errors.js";
import { ffprobe, readProbe } from "../ffmpeg/ffprobe.js";
import { toolVersion } from "../media-tools.js";
import { withWorkspace } from "../workspace.js";
import {
  assertWithinLimits,
  download,
  probeSource,
  ytDlpVersion,
  type AcquireLimits,
} from "../yt-dlp.js";

import type { JobContext, ProcessorOutcome } from "../runtime.js";

/**
 * `media.acquire` — bring an authorised external source into object storage.
 *
 * ```
 * normalised URL (the API already parsed it)
 *   -> yt-dlp --dump-single-json      metadata only: live? too long? too big?
 *   -> yt-dlp <closed arg list>       into a job-scoped temp directory
 *   -> ffprobe the RESULT             what landed, not what was promised
 *   -> sha256 + upload to the raw key
 *   -> POST /internal/jobs/{id}/complete
 * ```
 *
 * This is the only media job that downloads its source. `media.probe` reads
 * through a presigned URL and never writes a file; here the bytes are genuinely
 * fetched from the public internet, so this is where the plan's duration, size,
 * wall-time and temp-disk caps do real work rather than being belt-and-braces.
 *
 * Three decisions worth keeping:
 *
 *   * **Nothing from the source chooses a path.** The output template points into
 *     a directory `withWorkspace` made, and the storage key is rebuilt from the
 *     envelope's ids. A remote title with `../` in it is just a title.
 *   * **Limits are checked twice.** Once against the metadata, so an oversized
 *     video costs one request rather than a partial download; once against the
 *     file, because a source can lie and `--max-filesize` is advisory on some
 *     sites.
 *   * **The completion handler enqueues `media.probe`, not this processor.** What
 *     happens next is policy, and policy does not belong in a worker that any pod
 *     can run — the same rule `probe.ts` follows.
 *
 * Unreachable in production while `source_youtube_acquire` is disabled: the API
 * refuses to create a link-sourced run at all, so nothing enqueues this.
 */
export interface AcquirePayload {
  readonly runId: string;
  readonly projectId: string;
  readonly mediaId: string;
  readonly source: {
    readonly kind: "youtube_url" | "direct_media_url";
    readonly normalizedUrl: string;
    readonly sourceId: string | null;
  };
  readonly destination: { readonly bucket: string; readonly key: string };
  readonly limits: AcquireLimits;
}

/** The filename inside the scratch directory. Ours, never the source's. */
const OUTPUT_NAME = "source.mp4";

export async function processAcquire(context: JobContext): Promise<ProcessorOutcome> {
  const { settings, envelope } = context;
  const payload = envelope.payload as unknown as AcquirePayload;

  assertAcquirableUrl(payload.source.normalizedUrl);
  const limits = payload.limits;

  return withWorkspace("acquire", settings.tempDir, async (workspace) => {
    context.report(2, "checking the video");

    const metadata = await probeSource({
      binary: settings.ytDlpPath,
      url: payload.source.normalizedUrl,
      limits,
      signal: context.signal,
    });

    context.report(5, "getting your video");
    const outputPath = workspace.path(OUTPUT_NAME);
    await download({
      binary: settings.ytDlpPath,
      url: payload.source.normalizedUrl,
      outputPath,
      limits,
      signal: context.signal,
      onProgress: (percent) => {
        // 5-70% of the job is the download; the rest is probing and uploading.
        context.report(5 + Math.round(percent * 0.65), "getting your video");
      },
    });

    // What LANDED, not what was promised. A source that under-reported its size
    // or duration is caught here, after the temp directory has absorbed it and
    // before a single byte reaches the workspace's storage.
    const sizeBytes = await workspace.size(OUTPUT_NAME);
    if (sizeBytes > limits.maxBytes) {
      throw unreadableMedia("that video is larger than your plan allows", "media/unsupported");
    }
    if (sizeBytes === 0) {
      throw unreadableMedia("that download produced an empty file", "media/corrupt");
    }

    context.report(75, "checking the file");
    const probed = readProbe(
      await ffprobe({
        binary: settings.ffprobePath,
        source: outputPath,
        timeoutMs: settings.ffmpegTimeoutMs,
        signal: context.signal,
      }),
    );
    if (probed.video === null && probed.audio === null) {
      throw unreadableMedia("that file has no video or audio in it", "media/no_streams");
    }
    assertWithinLimits(
      { ...metadata, durationMs: probed.durationMs, approximateBytes: sizeBytes, isLive: false },
      limits,
    );

    context.report(85, "saving your video");
    const checksum = await sha256(outputPath);
    // The key comes from the payload the API built out of ids it owns; this
    // worker does not construct one from anything the source said.
    await context.raw.putFile({
      key: payload.destination.key,
      file: outputPath,
      contentType: probed.mime ?? "video/mp4",
    });

    context.report(95, "reporting");

    return {
      result: {
        mediaId: payload.mediaId,
        bucket: payload.destination.bucket,
        key: payload.destination.key,
        filename: OUTPUT_NAME,
        mime: probed.mime ?? "video/mp4",
        sizeBytes,
        checksum,
        sourceMetadata: {
          provider: metadata.provider,
          sourceId: metadata.sourceId,
          title: metadata.title,
          channel: metadata.channel,
          durationMs: probed.durationMs,
        },
        toolVersion: `yt-dlp ${await ytDlpVersion(settings.ytDlpPath)}`,
        deduplicated: false,
        probeToolVersion: await toolVersion("ffprobe", settings.ffprobePath),
      },
      // The measured facts only. `status` stays with the API, exactly as it does
      // for `media.probe`: the completion handler applies the plan's caps and
      // enqueues the normal probe chain.
      mediaPatch: {
        sizeBytes,
        contentHash: checksum,
        mime: probed.mime,
        durationMs: probed.durationMs,
      },
    };
  });
}

/**
 * The worker's own URL check.
 *
 * The API has already normalised this (REP-009), and a worker that trusted that
 * would be trusting a payload — which §8.2 says explicitly not to do. A job can
 * be replayed from the dead-letter queue a month after the code that built it
 * changed, so the boundary re-checks: HTTPS, no credentials, and a host the
 * downloader is allowed to be pointed at.
 */
export function assertAcquirableUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw unreadableMedia("that link is not a valid address", "media/unsupported");
  }
  if (url.protocol !== "https:") {
    throw unreadableMedia("that link does not use a secure connection", "media/unsupported");
  }
  if (url.username !== "" || url.password !== "") {
    throw unreadableMedia("that link carries a username or password", "media/unsupported");
  }
  return url;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the path is inside this job's own scratch directory
  await stat(path);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

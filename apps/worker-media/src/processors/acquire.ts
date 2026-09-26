import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { sourceRefused, unreadableMedia } from "../errors.js";
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
 *   * **Limits are checked three times.** Against the metadata, so an oversized
 *     video costs one request rather than a partial download; against the bytes
 *     on disk while they arrive (`download` kills the downloader past the cap,
 *     which `--max-filesize` never does for a fragmented stream); and against
 *     the file, because a source can lie.
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

/**
 * The envelope version this processor writes — `media.acquire@1`.
 *
 * A literal rather than an import because this worker does not depend on
 * `@montaj/repurpose-contracts`, and pulling a Zod package into a media worker
 * to read one number is not a trade worth making. What keeps it honest is
 * `acquire-result.parity.test.ts` on the API side: it reads this file and the
 * contract, and fails if either the version or the field list drifts. That test
 * exists because both had already drifted — a result with no `schemaVersion`
 * parses nowhere, and the API would have rejected every completion.
 */
const RESULT_SCHEMA_VERSION = 1;

export async function processAcquire(context: JobContext): Promise<ProcessorOutcome> {
  const { settings, envelope } = context;
  const payload = envelope.payload as unknown as AcquirePayload;

  // The API refuses a direct media URL at creation, because nothing yet stops
  // a downloader on this machine from being pointed at an address only this
  // machine can reach. A replayed or hand-built job must not get round that.
  if (payload.source.kind !== "youtube_url") {
    throw unreadableMedia("that kind of link cannot be fetched yet", "media/unsupported");
  }
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
    let downloaded = 0;
    await download({
      binary: settings.ytDlpPath,
      url: payload.source.normalizedUrl,
      outputPath,
      limits,
      format: metadata.formatSelector ?? null,
      // The file the boot check ran, so the merge uses it too; a bare name
      // that is on no PATH directory is left for yt-dlp to look for itself.
      ffmpegPath: settings.ffmpegLocation ?? settings.ffmpegPath,
      signal: context.signal,
      onProgress: (percent) => {
        // A split download counts 0-100% for the picture and again for the
        // sound; the rail only ever moves forward.
        downloaded = Math.max(downloaded, percent);
        // 5-70% of the job is the download; the rest is probing and uploading.
        context.report(5 + Math.round(downloaded * 0.65), "getting your video");
      },
    });

    // What LANDED, not what was promised. A source that under-reported its size
    // or duration is caught here, after the temp directory has absorbed it and
    // before a single byte reaches the workspace's storage.
    const sizeBytes = await workspace.size(OUTPUT_NAME);
    if (sizeBytes > limits.maxBytes) {
      throw sourceRefused("media/too_large", "that video is larger than your plan allows");
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
        schemaVersion: RESULT_SCHEMA_VERSION,
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

/** `/watch?v=<id>`, `/<id>` (a short link) or `/embed/<id>`. */
type VideoPath = "watch" | "short" | "embed";

/**
 * Where the downloader may be pointed, and the one path shape each host may
 * carry. `URL` has already lower-cased the host. The hosts are the API's
 * (`YOUTUBE_HOSTS` and `YOUTUBE_SHORT_HOSTS` in `apps/api/src/repurpose/source-url.ts`).
 */
const ACQUIRABLE_HOSTS: ReadonlyMap<string, VideoPath> = new Map<string, VideoPath>([
  ["youtube.com", "watch"],
  ["www.youtube.com", "watch"],
  ["m.youtube.com", "watch"],
  ["music.youtube.com", "watch"],
  ["youtube-nocookie.com", "embed"],
  ["www.youtube-nocookie.com", "embed"],
  ["youtu.be", "short"],
  ["www.youtu.be", "short"],
]);

/** A YouTube video id: exactly 11 characters of the URL-safe alphabet (as the API's `VIDEO_ID`). */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The worker's own URL check.
 *
 * The API has already normalised this (REP-009), and a worker that trusted that
 * would be trusting a payload — which §8.2 says explicitly not to do. A job can
 * be replayed from the dead-letter queue a month after the code that built it
 * changed, so the boundary re-checks: HTTPS, no credentials, no port, a host
 * the downloader is allowed to be pointed at, and one video on it.
 *
 * The host is not enough on its own. yt-dlp's generic extractor will follow a
 * redirect anywhere, including to an address only this machine can reach, and
 * an allowed host has paths that are redirects (`/redirect?q=`,
 * `/attribution_link?u=`) or that the YouTube extractor does not claim. So the
 * path must be a video's: `/watch?v=<id>` and nothing else — the only form the
 * API has ever produced — or its `youtu.be/<id>` and `/embed/<id>` equivalents.
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
  const shape = ACQUIRABLE_HOSTS.get(url.hostname);
  if (url.port !== "" || shape === undefined) {
    throw unreadableMedia("that link is not on a site we can fetch from", "media/unsupported");
  }
  if (!isOneVideo(url, shape)) {
    throw unreadableMedia("that link is not a single video", "media/unsupported");
  }
  return url;
}

function isOneVideo(url: URL, shape: VideoPath): boolean {
  if (url.hash !== "") return false;
  if (shape === "watch") {
    const params = [...url.searchParams.keys()];
    return (
      url.pathname === "/watch" &&
      params.length === 1 &&
      params[0] === "v" &&
      VIDEO_ID.test(url.searchParams.get("v") ?? "")
    );
  }
  const prefix = shape === "short" ? "/" : "/embed/";
  return (
    url.search === "" &&
    url.pathname.startsWith(prefix) &&
    VIDEO_ID.test(url.pathname.slice(prefix.length))
  );
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the path is inside this job's own scratch directory
  await stat(path);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

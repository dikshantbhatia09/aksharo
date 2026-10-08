import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  MediaJobError,
  knownFacts,
  sourceRefused,
  transientFailure,
  unreadableMedia,
} from "../errors.js";
import { ffprobe, readProbe } from "../ffmpeg/ffprobe.js";
import { FFMPEG_BASE_ARGS, run } from "../ffmpeg/run.js";
import { logger } from "../logger.js";
import { toolVersion } from "../media-tools.js";
import { globalProxyPool } from "../proxy-pool.js";
import { withWorkspace } from "../workspace.js";
import {
  SECTION_MIN_REALTIME,
  WINDOW_TOLERANCE_MS,
  assertWithinLimits,
  download,
  formatSeconds,
  planSection,
  probeSource,
  ytDlpVersion,
  type AcquireLimits,
  type AcquireWindow,
  type HostedExtractor,
  type SectionPlan,
  type SourceMetadata,
  type WindowPolicy,
} from "../yt-dlp.js";

import type { ProbeContainer } from "../ffmpeg/ffprobe.js";
import type { JobContext, ProcessorOutcome } from "../runtime.js";
import type { Workspace } from "../workspace.js";

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
 * ## A window, when the source is longer than the plan processes
 *
 * The plan limits the minutes a run PROCESSES, not the length of the video. A
 * job with a `window` whose source is longer than `window.maxMs` fetches only
 * a section of it (`planSection`: the user's start, YouTube's most-replayed
 * peak, or the start), and reports where that section sits as the result's
 * `section`. Downstream everything runs on the landed file's own clock.
 *
 * ```
 * section download (yt-dlp --download-sections, ffmpeg's reader)
 *   └─ failed for a reason nobody named, or slower than 2x its running time?
 *        whole file fits the plan and the disk -> fetch it whole, cut the section here (-c copy)
 *        otherwise                             -> retryable failure
 * landed file longer than the window + 15 s (a source that under-reported its
 * length, or a downloader that ignored the section) -> cut here, as above
 * ```
 *
 * `section` always describes the file that is stored: a whole source short
 * enough to keep (within the window's 15 s tolerance) is reported as the whole
 * source, never as the part the plan would have cut from it, and a section
 * that came back shorter than asked ends where it actually ends. The API
 * places the next window from it.
 *
 * A short source, or a job with no window (every job built before windows
 * existed), downloads whole, exactly as before.
 *
 * ## Disk
 *
 * The runtime admitted this job against the floor, before anyone knew how big
 * the video is. Once the metadata says, the download needs the floor plus
 * twice its size free, and so does a whole-video fallback before it starts —
 * that fallback is the one download here that can be ten gigabytes, on a
 * volume Postgres and MinIO share. While any download runs, it stops once the
 * volume falls below the reserve (`disk.ts`). Each is a retryable
 * `media/disk_full`.
 *
 * Unreachable in production while `source_youtube_acquire` is disabled: the API
 * refuses to create a link-sourced run at all, so nothing enqueues this.
 *
 * ## Vimeo, Google Drive and Dropbox (2026-10-01)
 *
 * A `hosted_url` job is the same fetch for a public link on one of those
 * sites. Three things differ, and only three: the address must be exactly one
 * the API rebuilds from the run's fingerprint ({@link assertHostedUrl}), yt-dlp
 * is held to that site's own extractor (`--use-extractors`, so its generic
 * extractor never reads a page), and a most-replayed window is the start
 * ({@link windowForSite}), since only YouTube publishes a heatmap. The API
 * keeps its YouTube source gate for YouTube; nothing here knows about it.
 * **Deploy this worker before an api that sends `hosted_url`**: an older one
 * refuses the kind as `media/unsupported`, which fails the run rather than
 * fetching it.
 */
export interface AcquirePayload {
  readonly runId: string;
  readonly projectId: string;
  readonly mediaId: string;
  readonly source: {
    /** `hosted_url` (2026-10-01): a public Vimeo, Google Drive or Dropbox link. */
    readonly kind: "youtube_url" | "hosted_url" | "direct_media_url" | "cloud_stream";
    readonly normalizedUrl: string;
    readonly sourceId: string | null;
    readonly provider?: "GOOGLE_DRIVE" | "DROPBOX" | "ONEDRIVE" | "BOX" | string;
    readonly fileId?: string;
    readonly token?: string;
    readonly directLink?: string;
    readonly path?: string;
    readonly importJobId?: string;
  };
  readonly destination: { readonly bucket: string; readonly key: string };
  readonly limits: AcquireLimits;
  readonly window?: AcquireWindow;
}

/** The filename inside the scratch directory. Ours, never the source's. */
const OUTPUT_NAME = "source.mp4";

/** A section's own directory, so a fallback never counts its leftovers. */
const SECTION_DIR = "section";

/** What a local cut writes. */
const WINDOW_NAME = "window.mp4";

/**
 * The least time a fallback download is started with. With less left of the
 * job's limit, fetching the whole video cannot finish, and a retry — a fresh
 * limit — is the better use of the one acquisition slot.
 */
const FALLBACK_MIN_MS = 60_000;

/** The longest window or start a payload may carry: the contract's 24 hours. */
const MAX_WINDOW_MS = 86_400_000;

const WINDOW_POLICIES: readonly WindowPolicy[] = ["first", "most_replayed", "range"];

/**
 * Failures a section download ends with that fetching the whole file cannot
 * fix: a stop, the job's own time limit spent, a binary that will not start,
 * a disk that is already nearly full.
 */
const NO_FALLBACK_CODES: ReadonlySet<string> = new Set([
  "media/cancelled",
  "media/tool_timeout",
  "media/tool_spawn",
  "media/disk_full",
]);

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

  // Zero-Disk Cloud Storage Streaming Pipeline (Pillar 1 §02)
  if (payload.source.kind === "cloud_stream" || (payload.source as any).provider) {
    context.report(5, "connecting to cloud storage provider");
    const provider = String((payload.source as any).provider || "").toUpperCase();
    let streamResult;
    if (provider === "GOOGLE_DRIVE") {
      const { getGoogleDriveStream } = await import("../cloud/google-drive-stream.js");
      streamResult = await getGoogleDriveStream({
        fileId: (payload.source as any).fileId!,
        accessToken: (payload.source as any).token!,
        signal: context.signal,
      });
    } else if (provider === "DROPBOX") {
      const { getDropboxStream } = await import("../cloud/dropbox-stream.js");
      streamResult = await getDropboxStream({
        pathOrId: (payload.source as any).fileId || (payload.source as any).path,
        directLink: (payload.source as any).directLink,
        accessToken: (payload.source as any).token,
        signal: context.signal,
      });
    } else {
      throw unreadableMedia(`cloud provider ${provider} not supported yet`, "media/unsupported");
    }

    context.report(15, `streaming ${streamResult.fileName} directly to storage`);
    const s3Client = (context.raw as any).getClient?.();
    let uploadedBytes = 0;

    const { uploadStreamToS3 } = await import("../cloud/s3-stream-uploader.js");
    if (s3Client) {
      const uploadRes = await uploadStreamToS3({
        client: s3Client,
        bucket: payload.destination.bucket,
        key: payload.destination.key,
        stream: streamResult.stream,
        contentType: streamResult.mimeType || "video/mp4",
        totalExpectedBytes: streamResult.fileSizeBytes,
        onProgress: (p) => {
          const pct = Math.min(95, Math.max(15, 15 + Math.round(p.percentage * 0.8)));
          context.report(pct, `streaming ${String(p.percentage)}%`, {
            bytesDone: p.loaded,
            bytesTotal: streamResult.fileSizeBytes || p.total,
          });
        },
        signal: context.signal,
      });
      uploadedBytes = uploadRes.totalBytesUploaded;
    } else if (context.raw.uploadStream) {
      uploadedBytes = await context.raw.uploadStream({
        key: payload.destination.key,
        stream: streamResult.stream,
        contentType: streamResult.mimeType || "video/mp4",
        totalExpectedBytes: streamResult.fileSizeBytes,
        onProgress: (p) => {
          const pct = Math.min(95, Math.max(15, 15 + Math.round(p.percentage * 0.8)));
          context.report(pct, `streaming ${String(p.percentage)}%`, {
            bytesDone: p.loaded,
            bytesTotal: streamResult.fileSizeBytes || p.total,
          });
        },
        signal: context.signal,
      });
    }

    context.report(98, "saving your video");
    return {
      result: {
        schemaVersion: RESULT_SCHEMA_VERSION,
        mediaId: payload.mediaId,
        bucket: payload.destination.bucket,
        key: payload.destination.key,
        filename: streamResult.fileName,
        mime: streamResult.mimeType || "video/mp4",
        sizeBytes: uploadedBytes,
        checksum: null,
        sourceMetadata: {
          provider: provider || "cloud_stream",
          sourceId: (payload.source as any).fileId || null,
          title: streamResult.fileName,
          channel: null,
          durationMs: 0,
        },
        toolVersion: "cloud-stream-ingest/1.0",
        deduplicated: false,
        probeToolVersion: "stream-uploader",
      },
      mediaPatch: {
        sizeBytes: uploadedBytes,
        contentHash: null,
        mime: streamResult.mimeType || "video/mp4",
      },
    };
  }

  // The API refuses a direct media URL at creation, because nothing yet stops
  // a downloader on this machine from being pointed at an address only this
  // machine can reach. A replayed or hand-built job must not get round that.
  //
  // A `hosted_url` (2026-10-01) is a Vimeo, Google Drive or Dropbox link: the
  // same fetch, with yt-dlp held to that one site's extractor.
  if (payload.source.kind !== "youtube_url" && payload.source.kind !== "hosted_url") {
    throw unreadableMedia("that kind of link cannot be fetched yet", "media/unsupported");
  }
  const { extractor } = acquirableSource(payload.source.kind, payload.source.normalizedUrl);
  const limits = payload.limits;
  const window = windowForSite(readWindow(payload.window), extractor);
  // One limit for the whole job, however many downloads it takes: the API
  // counts an acquire running past `timeoutMs` (+10 min) as stalled.
  const deadline = Date.now() + limits.timeoutMs;
  const jsRuntime = settings.ytDlpJsRuntime;

  return withWorkspace("acquire", settings.tempDir, async (workspace) => {
    context.report(2, "checking the video");

    const probeOp = await globalProxyPool.executeWithProxyFailover(
      (proxyUrl, nodeName) =>
        probeSource({
          binary: settings.ytDlpPath,
          url: payload.source.normalizedUrl,
          limits,
          signal: context.signal,
          ...(jsRuntime === undefined ? {} : { jsRuntime }),
          ...(settings.ytDlpYoutubePlayerClient === undefined ? {} : { youtubePlayerClient: settings.ytDlpYoutubePlayerClient }),
          ...(window === undefined ? {} : { window }),
          ...(extractor === null ? {} : { extractor }),
          ...(proxyUrl ? { proxyUrl } : {}),
          egressProxyNode: nodeName,
        }),
      { sessionId: payload.mediaId, maxRetries: 3 },
    );
    const metadata = probeOp.result;
    const egressProxyUrl = probeOp.proxyUrl;

    // Now that the video's size is known: room for it, with the floor still
    // free after it. The runtime could only check the floor.
    await assertRoomToDownload(context, metadata.approximateBytes, payload.mediaId);

    context.report(5, "getting your video");
    let downloaded = 0;
    let downloadedBytes = 0;
    // What the source said the chosen formats weigh: the run page's "3.1 of
    // 5.0 GB", and what the API times the rest of the download against.
    const expectedBytes =
      metadata.approximateBytes !== null && metadata.approximateBytes > 0
        ? metadata.approximateBytes
        : null;
    const fetched = await fetchSource({
      context,
      workspace,
      payload,
      metadata,
      deadline,
      extractor,
      proxyUrl: egressProxyUrl,
      onProgress: (percent, bytes) => {
        // A split download counts 0-100% for the picture and again for the
        // sound, and a fallback starts again from 0; the rail only ever moves
        // forward.
        downloaded = Math.max(downloaded, percent);
        // Bytes on disk when the download counts them (a section), else the
        // share of the expected size the percentage stands for.
        downloadedBytes = Math.max(
          downloadedBytes,
          bytes ?? (expectedBytes === null ? 0 : (downloaded / 100) * expectedBytes),
        );
        // 5-70% of the job is the download; the rest is probing and uploading.
        context.report(
          5 + Math.round(downloaded * 0.65),
          "getting your video",
          expectedBytes === null
            ? undefined
            : { bytesDone: Math.min(downloadedBytes, expectedBytes), bytesTotal: expectedBytes },
        );
      },
    });
    let outputPath = fetched.path;

    // What LANDED, not what was promised. A source that under-reported its size
    // or duration is caught here, after the temp directory has absorbed it and
    // before a single byte reaches the workspace's storage.
    context.report(75, "checking the file");
    let { sizeBytes, probed } = await measureLanded(context, outputPath, limits);

    const placed = placeLanded({
      window,
      planned: fetched.section,
      whole: fetched.whole,
      landedMs: probed.durationMs,
      replayedPeakMs: metadata.replayedPeakMs ?? null,
    });
    let section = placed.section;
    if (placed.cut !== null) {
      // The whole file arrived (a fallback, a source that did not say how long
      // it was, a downloader that ignored the section), longer than the
      // window: only the window of it is kept.
      const plan = placed.cut;
      context.report(78, "keeping the part we will use");
      const cut = workspace.path(WINDOW_NAME);
      await cutSection(context, outputPath, cut, plan);
      // The whole file is gigabytes on a paid plan; it goes before the hash
      // and the upload, not with the workspace at the end.
      await rm(outputPath, { force: true });
      outputPath = cut;
      ({ sizeBytes, probed } = await measureLanded(context, outputPath, limits));
      const expectedMs = plan.endMs - plan.startMs;
      if (
        probed.durationMs > expectedMs + WINDOW_TOLERANCE_MS ||
        probed.durationMs < expectedMs / 2
      ) {
        throw transientFailure(
          "media/acquire_trim_failed",
          `the cut part is ${String(probed.durationMs)} ms, not about ${String(expectedMs)} ms`,
          { reason: "media/source_failed" },
        );
      }
      section = endingAt(plan, probed.durationMs);
    }
    assertWithinLimits(
      { ...metadata, durationMs: probed.durationMs, approximateBytes: sizeBytes, isLive: false },
      limits,
    );

    // A stop that came while the file was checked. Hashing first would only
    // delay the same answer, and on a paid plan's multi-gigabyte file that is
    // a minute or more of the one acquisition slot every run shares.
    throwIfStopped(context.signal);
    context.report(85, "saving your video");
    const checksum = await sha256(outputPath, context.signal);
    // The last moment a stop can still save something: the run was stopped
    // (or the worker is going away) after the download itself finished, and
    // nothing kills an upload. Stored now, the bytes would sit in raw under a
    // media row the API has already failed, with no scheduler running to
    // purge them — and this worker cannot delete an object (`storage.ts`), on
    // purpose. A stop that lands during the upload itself is past this point.
    throwIfStopped(context.signal);
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
          ...(metadata.nativeChapters ? { chapters: metadata.nativeChapters } : {}),
          ...(metadata.egressProxyNode ? { egressProxyNode: metadata.egressProxyNode } : {}),
        },
        // Only when a window was applied: absent means the whole source landed.
        ...(section === null ? {} : { section: sectionResult(section) }),
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
 * The payload's `window`, checked (§8.2: a payload is a request, not a fact),
 * or `undefined` when there is none. A malformed one is a producer bug that
 * no retry changes.
 */
export function readWindow(value: unknown): AcquireWindow | undefined {
  if (value === undefined || value === null) return undefined;
  const bad = (): MediaJobError =>
    new MediaJobError("media/bad_payload", "the job's window is not one this worker can use", {
      retryable: false,
      reason: "media/source_failed",
    });
  if (typeof value !== "object") throw bad();
  const { maxMs, startMs, policy } = value as Record<string, unknown>;
  const whole = (ms: unknown): ms is number =>
    typeof ms === "number" && Number.isSafeInteger(ms) && ms >= 0 && ms <= MAX_WINDOW_MS;
  if (!whole(maxMs) || maxMs === 0) throw bad();
  if (startMs !== undefined && !whole(startMs)) throw bad();
  if (!WINDOW_POLICIES.includes(policy as WindowPolicy)) throw bad();
  return {
    maxMs,
    ...(startMs === undefined ? {} : { startMs }),
    policy: policy as WindowPolicy,
  };
}

/**
 * What the landed file is, in the source's clock: the part to cut out of it
 * (`cut`, when it is the whole source and longer than the window), and the
 * `section` to report for what is stored (`null`: the whole source).
 *
 * - **A section download** is its planned section, ending where the file
 *   actually ends when that is sooner (a reader that lost its connection
 *   writes a short file and exits 0). Under half of what was asked is not a
 *   section anyone should build clips from: a retryable failure. Longer than
 *   the window, it is the whole source (yt-dlp ignored the section) to be cut
 *   — or, not even that long, a file nobody here can place.
 * - **The whole source** (the fallback, or a source whose metadata gave no
 *   duration to plan with) short enough to keep, within the window's
 *   tolerance, is kept whole and reported as the whole source. Reporting the
 *   plan's section instead put its start up to 15 s off the file's real
 *   start, and the API placed the next window from that. Longer, it is cut
 *   to the plan (re-placed on the file's own length when the metadata's was
 *   wrong).
 *
 * Exported for its tests.
 */
export function placeLanded(input: {
  readonly window: AcquireWindow | undefined;
  /** The section that was planned from the metadata; `null` for none. */
  readonly planned: SectionPlan | null;
  /** True when the whole source was downloaded (no `--download-sections`). */
  readonly whole: boolean;
  /** ffprobe's duration of what landed. */
  readonly landedMs: number;
  readonly replayedPeakMs: number | null;
}): { readonly cut: SectionPlan | null; readonly section: SectionPlan | null } {
  const { window, planned, landedMs } = input;
  if (window === undefined) return { cut: null, section: null };
  const fits = landedMs <= window.maxMs + WINDOW_TOLERANCE_MS;
  const sameAsSource = (plan: SectionPlan): boolean =>
    Math.abs(landedMs - plan.sourceDurationMs) <= WINDOW_TOLERANCE_MS;

  if (!input.whole && planned !== null) {
    if (fits) {
      const askedMs = planned.endMs - planned.startMs;
      if (landedMs < askedMs / 2) {
        throw transientFailure(
          "media/acquire_section_short",
          `the part of the video that arrived is ${String(landedMs)} ms, not about ${String(askedMs)} ms`,
          { reason: "media/source_failed" },
        );
      }
      return { cut: null, section: endingAt(planned, landedMs) };
    }
    if (!sameAsSource(planned)) {
      // Neither the section nor the whole source: nothing here knows where
      // this file sits in the video, so no cut of it can be trusted.
      throw transientFailure(
        "media/acquire_section_mismatch",
        "the part of the video that arrived is not the part that was asked for",
        { reason: "media/source_failed" },
      );
    }
    return { cut: planned, section: planned };
  }

  if (fits) return { cut: null, section: null };
  const plan =
    planned !== null && sameAsSource(planned)
      ? planned
      : planSection({ durationMs: landedMs, window, replayedPeakMs: input.replayedPeakMs });
  if (plan === null) {
    throw transientFailure("media/acquire_window", "the window could not be placed", {
      reason: "media/source_failed",
    });
  }
  return { cut: plan, section: plan };
}

/**
 * `section`, ending where a file of `landedMs` that starts at its start ends,
 * when that is sooner than planned. Never later: a stream copy starts on the
 * keyframe before the cut, so a whole section is a little LONGER than asked.
 */
function endingAt(section: SectionPlan, landedMs: number): SectionPlan {
  const endMs = Math.min(section.endMs, section.startMs + Math.max(0, Math.round(landedMs)));
  return endMs === section.endMs ? section : { ...section, endMs };
}

/**
 * Room on the scratch volume for a download of about `bytes`, with the floor
 * still free after it; a retryable `media/disk_full` when there is not. The
 * retry comes back through the runtime's admission, which holds it — without
 * spending anything — until there is room.
 */
async function assertRoomToDownload(
  context: JobContext,
  bytes: number | null,
  mediaId: string,
): Promise<void> {
  if (context.disk === undefined) return;
  const verdict = await context.disk.roomToDownload(bytes);
  if (verdict.admit) return;
  logger.warn("not enough free disk for this download", {
    mediaId,
    expectedBytes: bytes,
    freeBytes: verdict.freeBytes,
    requiredBytes: verdict.requiredBytes,
    path: verdict.path,
  });
  throw transientFailure(
    "media/disk_full",
    "there is not enough free disk to fetch that video now",
    {
      reason: "media/source_failed",
      detail: `free ${String(verdict.freeBytes)} bytes, needs ${String(verdict.requiredBytes)}`,
    },
  );
}

/** The result's `section`: exactly the contract's four fields. */
function sectionResult(section: SectionPlan): Record<string, unknown> {
  return {
    startMs: section.startMs,
    endMs: section.endMs,
    sourceDurationMs: section.sourceDurationMs,
    policy: section.policy,
  };
}

/**
 * Download what the metadata planned: the whole source, or its section with
 * the whole-file fallback (see the module comment). Returns the landed file,
 * whether it is the whole source, and the section that was planned (`null`
 * for none) — which {@link placeLanded} turns into what the file holds.
 */
async function fetchSource(input: {
  readonly context: JobContext;
  readonly workspace: Workspace;
  readonly payload: AcquirePayload;
  readonly metadata: SourceMetadata;
  readonly deadline: number;
  /** The one yt-dlp extractor a hosted link may use; `null` for YouTube. */
  readonly extractor: HostedExtractor | null;
  /** `bytes` when the download counts them itself (a section's bytes on disk). */
  readonly onProgress: (percent: number, bytes?: number) => void;
  readonly proxyUrl?: string;
}): Promise<{
  readonly path: string;
  readonly whole: boolean;
  readonly section: SectionPlan | null;
}> {
  const { context, workspace, payload, metadata, deadline } = input;
  const { settings } = context;
  const limits = payload.limits;
  const disk = context.disk;
  const common = {
    binary: settings.ytDlpPath,
    url: payload.source.normalizedUrl,
    // The file the boot check ran, so the merge uses it too; a bare name
    // that is on no PATH directory is left for yt-dlp to look for itself.
    ffmpegPath: settings.ffmpegLocation ?? settings.ffmpegPath,
    signal: context.signal,
    onProgress: input.onProgress,
    ...(settings.ytDlpJsRuntime === undefined ? {} : { jsRuntime: settings.ytDlpJsRuntime }),
    ...(settings.ytDlpYoutubePlayerClient === undefined ? {} : { youtubePlayerClient: settings.ytDlpYoutubePlayerClient }),
    ...(input.extractor === null ? {} : { extractor: input.extractor }),
    ...(input.proxyUrl === undefined ? {} : { proxyUrl: input.proxyUrl }),
    // Every download stops before the volume it shares with the database
    // falls below the reserve, whatever its own size.
    ...(disk === undefined ? {} : { lowDisk: async () => disk.belowReserve() }),
  };

  const section = metadata.section ?? null;
  if (section === null) {
    const path = workspace.path(OUTPUT_NAME);
    await download({
      ...common,
      outputPath: path,
      limits,
      format: metadata.formatSelector ?? null,
    });
    return { path, whole: true, section: null };
  }

  const wholeBytes = metadata.wholeBytes ?? null;
  const wholeFits = wholeBytes !== null && wholeBytes <= limits.maxBytes;
  const expected = metadata.approximateBytes;
  const sectionDir = workspace.path(SECTION_DIR);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed name inside this job's own scratch directory
  await mkdir(sectionDir);
  const sectionPath = join(sectionDir, OUTPUT_NAME);
  try {
    await download({
      ...common,
      outputPath: sectionPath,
      limits: { ...limits, timeoutMs: Math.max(1_000, deadline - Date.now()) },
      format: metadata.formatSelector ?? null,
      section,
      // Held to the pace only when there is a faster road to take instead.
      // With no fallback, a slow section that finishes beats a failed run.
      ...(wholeFits
        ? {
            pace: {
              mediaMs: section.endMs - section.startMs,
              expectedBytes: expected,
              minRealtime: SECTION_MIN_REALTIME,
            },
          }
        : {}),
      // ffmpeg's reader prints no percentage; the bytes on disk are the progress.
      onBytes: (bytes) => {
        if (expected !== null && expected > 0) {
          input.onProgress(Math.min(99, (bytes / expected) * 100), bytes);
        }
      },
    });
    return { path: sectionPath, whole: false, section };
  } catch (error) {
    if (!worthFallingBack(error, context.signal)) throw error;
    const left = deadline - Date.now();
    // The whole video is the largest download this worker makes — ten
    // gigabytes on the internal plan — so it needs its own room, measured
    // now, not the section's.
    const room = wholeFits && disk !== undefined ? await disk.roomToDownload(wholeBytes) : null;
    const why = !wholeFits
      ? "we could not fetch that part of the video, and the whole video is larger than the plan allows"
      : left < FALLBACK_MIN_MS
        ? "there was no time left to fetch the whole video instead of its part"
        : room !== null && !room.admit
          ? "we could not fetch that part of the video, and there is not enough free disk to fetch the whole video instead"
          : null;
    if (why !== null) {
      throw transientFailure("media/acquire_section_failed", why, {
        cause: error,
        reason: "media/source_failed",
        ...(error instanceof MediaJobError && error.detail !== undefined
          ? { detail: error.detail }
          : {}),
      });
    }
    logger.warn("section download failed; fetching the whole video to cut it here", {
      mediaId: payload.mediaId,
      code: error instanceof MediaJobError ? error.code : "unknown",
      startMs: section.startMs,
      endMs: section.endMs,
      wholeBytes,
    });
    // Only to free the disk: the size watch counts the job's own directory,
    // not this one. Best effort, because an ffmpeg that outlived its kill can
    // still hold the file open (EBUSY on Windows), and that is no reason to
    // fail a job that can go on.
    await rm(sectionDir, { recursive: true, force: true }).catch((rmError: unknown) => {
      logger.warn("section download not removed; fetching the whole video beside it", {
        mediaId: payload.mediaId,
        error: rmError instanceof Error ? rmError.message : String(rmError),
      });
    });
    const path = workspace.path(OUTPUT_NAME);
    try {
      await download({
        ...common,
        outputPath: path,
        limits: { ...limits, timeoutMs: left },
        format: metadata.wholeFormatSelector ?? null,
      });
    } catch (wholeError) {
      // Over the cap after all: the estimate was wrong, not the user's choice
      // of video — the window itself fits, so this is no "too large".
      if (wholeError instanceof MediaJobError && wholeError.code === "media/too_large") {
        throw transientFailure(
          "media/acquire_section_failed",
          "the whole video turned out larger than its estimate",
          { cause: wholeError, reason: "media/source_failed" },
        );
      }
      throw wholeError;
    }
    return { path, whole: true, section };
  }
}

/** Whether a failed section download is one fetching the whole file might fix. */
function worthFallingBack(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  // A named refusal (private, removed, blocked, too large) is the same answer
  // for the whole file, and a block is made worse by asking again.
  return error instanceof MediaJobError && error.retryable && !NO_FALLBACK_CODES.has(error.code);
}

/**
 * Size and ffprobe of a landed file, with the refusals that go with them: over
 * the byte cap, empty, or neither picture nor sound.
 */
async function measureLanded(
  context: JobContext,
  path: string,
  limits: AcquireLimits,
): Promise<{ readonly sizeBytes: number; readonly probed: ProbeContainer }> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file this job wrote in its own scratch directory
  const sizeBytes = (await stat(path)).size;
  if (sizeBytes > limits.maxBytes) {
    throw sourceRefused(
      "media/too_large",
      "that video is larger than your plan allows",
      undefined,
      knownFacts({ approximateBytes: sizeBytes, maxBytes: limits.maxBytes }),
    );
  }
  if (sizeBytes === 0) {
    throw unreadableMedia("that download produced an empty file", "media/corrupt");
  }
  const probed = readProbe(
    await ffprobe({
      binary: context.settings.ffprobePath,
      source: path,
      timeoutMs: context.settings.ffmpegTimeoutMs,
      signal: context.signal,
    }),
  );
  if (probed.video === null && probed.audio === null) {
    throw unreadableMedia("that file has no video or audio in it", "media/no_streams");
  }
  return { sizeBytes, probed };
}

/**
 * Cut `section` out of a local file without re-encoding: `-ss` and `-t` from
 * checked integers, the first picture and sound streams, stream copy. The cut
 * starts on the keyframe before `startMs`, a few seconds early at most, which
 * the caller's length check allows for.
 */
async function cutSection(
  context: JobContext,
  source: string,
  output: string,
  section: SectionPlan,
): Promise<void> {
  const result = await run(
    context.settings.ffmpegPath,
    [
      ...FFMPEG_BASE_ARGS,
      "-loglevel",
      "error",
      "-ss",
      formatSeconds(section.startMs),
      "-t",
      formatSeconds(section.endMs - section.startMs),
      "-i",
      source,
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      output,
    ],
    { timeoutMs: context.settings.ffmpegTimeoutMs, signal: context.signal },
  );
  if (result.code !== 0) {
    throw transientFailure("media/acquire_trim_failed", "we could not cut that part of the video", {
      detail: result.stderr,
      reason: "media/source_failed",
    });
  }
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

/**
 * The link a job may fetch, for its kind, and the one yt-dlp extractor it is
 * held to (`null`: YouTube, whose path has never pinned one).
 *
 * A `youtube_url` is {@link assertAcquirableUrl}'s; a `hosted_url`
 * (2026-10-01) is {@link assertHostedUrl}'s. Neither kind is let through on
 * the other's hosts: a replayed job that says `hosted_url` about a YouTube
 * link would otherwise skip the source gate the API keeps for YouTube.
 */
export function acquirableSource(
  kind: "youtube_url" | "hosted_url",
  value: string,
): { readonly url: URL; readonly extractor: HostedExtractor | null } {
  if (kind === "youtube_url") return { url: assertAcquirableUrl(value), extractor: null };
  return assertHostedUrl(value);
}

/** A Vimeo video id, and an unlisted video's hash (as the API's `VIMEO_ID`, `VIMEO_HASH`). */
const VIMEO_PATH = /^\/video\/\d{1,15}$/;
const VIMEO_HASH = /^[0-9a-f]{10}$/;
/** `/file/d/{id}/view`: the only Drive address the API writes. */
const DRIVE_PATH = /^\/file\/d\/[A-Za-z0-9_-]{28,100}\/view$/;
/** `/s/{key}/{name}` and `/scl/fi/{id}/{name}`, the name as `encodeURIComponent` leaves it. */
const DROPBOX_S_PATH = /^\/s\/[A-Za-z0-9_-]{5,40}\/[A-Za-z0-9_.!~*'()%-]{1,95}$/;
const DROPBOX_SCL_PATH = /^\/scl\/fi\/[A-Za-z0-9_-]{5,40}\/[A-Za-z0-9_.!~*'()%-]{1,95}$/;
const DROPBOX_RLKEY = /^[A-Za-z0-9]{5,40}$/;

/** The canonical host of each site, and the extractor its links are held to. */
const HOSTED_HOSTS: ReadonlyMap<string, HostedExtractor> = new Map<string, HostedExtractor>([
  ["player.vimeo.com", "vimeo"],
  ["drive.google.com", "googledrive"],
  ["www.dropbox.com", "dropbox"],
]);

/**
 * The worker's own check of a `hosted_url` (2026-10-01): exactly one of the
 * addresses the API's `hostedUrlOf` (`apps/api/src/repurpose/source-url.ts`)
 * rebuilds from a fingerprint, and nothing else - one host each, one path
 * shape each, no port, no credentials, no fragment, and no query but a
 * Dropbox file link's `rlkey`. The hosts are deliberately the canonical ones
 * the API writes (`player.vimeo.com`, `drive.google.com`, `www.dropbox.com`), not
 * every spelling it accepts from a person.
 *
 * The extractor matters as much as the host. yt-dlp's generic extractor
 * follows a page anywhere it points, and Vimeo, Drive and Dropbox all serve
 * pages; held to `--use-extractors` with the site's own extractor, a page
 * that is not that site's video is an "unsupported URL", never a fetch of
 * whatever it links to.
 */
export function assertHostedUrl(value: string): {
  readonly url: URL;
  readonly extractor: HostedExtractor;
} {
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
  const extractor = HOSTED_HOSTS.get(url.hostname);
  if (url.port !== "" || extractor === undefined) {
    throw unreadableMedia("that link is not on a site we can fetch from", "media/unsupported");
  }
  if (!isOneHostedFile(url, extractor)) {
    throw unreadableMedia("that link is not a single video", "media/unsupported");
  }
  return { url, extractor };
}

function isOneHostedFile(url: URL, extractor: HostedExtractor): boolean {
  if (url.hash !== "") return false;
  if (extractor === "vimeo") {
    // `player.vimeo.com/video/{id}`, with `?h={hash}` alone for an unlisted one.
    if (!VIMEO_PATH.test(url.pathname)) return false;
    if (url.search === "") return true;
    const keys = [...url.searchParams.keys()];
    return keys.length === 1 && keys[0] === "h" && VIMEO_HASH.test(url.searchParams.get("h") ?? "");
  }
  if (extractor === "googledrive") return url.search === "" && DRIVE_PATH.test(url.pathname);
  if (DROPBOX_S_PATH.test(url.pathname)) return url.search === "";
  if (!DROPBOX_SCL_PATH.test(url.pathname)) return false;
  const params = [...url.searchParams.keys()];
  return (
    params.length === 1 &&
    params[0] === "rlkey" &&
    DROPBOX_RLKEY.test(url.searchParams.get("rlkey") ?? "")
  );
}

/**
 * A window as the link's site can honour it: only YouTube publishes a
 * most-replayed heatmap, so on Vimeo, Google Drive or Dropbox the window is
 * the start (2026-10-01). The API already asks for `first` there; this is the
 * boundary not trusting that (§8.2), and it keeps a stray heatmap-shaped
 * field in another site's metadata from placing the window.
 */
export function windowForSite(
  window: AcquireWindow | undefined,
  extractor: HostedExtractor | null,
): AcquireWindow | undefined {
  if (window === undefined || extractor === null || window.policy !== "most_replayed") {
    return window;
  }
  return { ...window, policy: "first" };
}

/**
 * End the job if it was stopped: its run was stopped (the runtime then ends it
 * without reporting anything), or the worker is going away. Retryable, so a
 * shutdown runs the job again.
 */
function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) {
    throw transientFailure("media/cancelled", "the download was stopped before it was saved", {
      reason: "media/source_failed",
    });
  }
}

/**
 * The file's SHA-256, read chunk by chunk and given up as soon as `signal` is
 * aborted — a paid plan's file is gigabytes, and a stopped run should not wait
 * for all of them to be read.
 *
 * Exported for its tests; the processor is the only caller.
 */
export async function sha256(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the path is inside this job's own scratch directory
  await stat(path);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above
  for await (const chunk of createReadStream(path)) {
    // Throwing out of the loop closes the stream.
    throwIfStopped(signal);
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

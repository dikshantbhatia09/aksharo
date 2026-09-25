import { Inject, Injectable, Logger } from "@nestjs/common";

import { MEDIA_JOB_KEYS, MEDIA_JOB_QUOTES } from "./media.constants.js";
import { AppException } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { DERIVED_STORE, RAW_STORE } from "../common/storage/index.js";
import { JOB_ERROR_CODES } from "../jobs/jobs.errors.js";
import { JobsService } from "../jobs/jobs.service.js";

import type { ObjectStore } from "../common/storage/index.js";

/**
 * Largest mezzanine {@link promoteToRaw} will copy. The API's object store reads
 * whole objects into memory; a repurposed clip is a short cut (<= 1080p, tens of
 * MB), so anything near this is a bug upstream, refused rather than buffered.
 */
export const PROMOTE_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Make sure `key` exists in the RAW store, copying it from the derived one if
 * that is where it is.
 *
 * `media.probe`, `media.proxy` and the renderer all read a primary asset from
 * the raw store — only raw — whatever bucket their payload names. `media.clip`
 * writes its mezzanine to the DERIVED store (the run's clip preview presigns it
 * there) and reports the bucket it was *asked* for. So a clip's mezzanine
 * becomes a child project's ordinary primary media only once a copy sits in
 * raw under the same key; without one the probe answers 404 `media/unreadable`.
 *
 * @returns whether a copy was made (false when raw already had it).
 */
export async function promoteToRaw(
  stores: { readonly raw: ObjectStore; readonly derived: ObjectStore },
  key: string,
  contentType: string,
  /** Replace a raw copy that is already there (a re-cut wrote new bytes to the same key). */
  options: { readonly overwrite?: boolean } = {},
): Promise<boolean> {
  if (options.overwrite !== true && (await stores.raw.head(key)) !== null) return false;
  const source = await stores.derived.head(key);
  if (source === null) {
    throw new Error(`${key} is in neither the raw nor the derived store`);
  }
  if (source.sizeBytes > PROMOTE_MAX_BYTES) {
    throw new Error(
      `${key} is ${String(source.sizeBytes)} bytes; refusing to copy more than ${String(PROMOTE_MAX_BYTES)} through the API`,
    );
  }
  const body = await stores.derived.get(key);
  await stores.raw.put({ key, body, contentType });
  return true;
}

/** The asset fields `media.probe` is told about. */
export interface ProbeTarget {
  readonly id: string;
  readonly storageKey: string;
  readonly mime: string | null;
  readonly sizeBytes: bigint | null;
}

/** What `media.probe` is told about an asset. One definition, every caller. */
export function probeJobPayload(
  media: ProbeTarget,
  projectId: string,
  buckets: { readonly raw: "s3" | "r2"; readonly derived: "s3" | "r2" },
): Record<string, unknown> {
  return {
    mediaId: media.id,
    projectId,
    bucket: buckets.raw,
    key: media.storageKey,
    mime: media.mime,
    sizeBytes: Number(media.sizeBytes ?? 0),
    derivedBucket: buckets.derived,
    derivedPrefix: media.storageKey.slice(0, media.storageKey.lastIndexOf("/")),
  };
}

/**
 * A primary asset that claims `ready` but never went through `media.probe`.
 *
 * Every probe writes `hasAudio` (a boolean, never null); a video that was probed
 * and proxied also has a `width` and a `proxyKey`. All three missing is the
 * signature `media.clip` left on every repurposed clip before 2026-09-25: the
 * mezzanine stamped `ready` with nothing measured and no preview built.
 */
export function neverProbed(media: {
  readonly status: string;
  readonly hasAudio: boolean | null;
  readonly width: number | null;
  readonly proxyKey: string | null;
}): boolean {
  return (
    media.status === "ready" &&
    media.hasAudio === null &&
    media.width === null &&
    media.proxyKey === null
  );
}

/**
 * What {@link MediaProbeRestart.restart} managed:
 *
 * - `queued`: the probe is on its way (or already was).
 * - `busy`: the workspace's plan lane is full right now (`jobs/concurrency_cap`
 *   — a Free workspace allows two jobs in flight). Temporary: ask again later.
 * - `failed`: it cannot be probed (the video is in neither store, or the
 *   enqueue failed for a reason waiting will not fix).
 */
export type ProbeRestartOutcome = "queued" | "busy" | "failed";

/**
 * Send an unprobed asset back through the ordinary pipeline:
 * `media.probe` → `media.proxy` → (on proxy success) `AutoTranscribeTrigger`,
 * which builds the editing document from a transcript the project already has.
 *
 * Lives beside the media pipeline it restarts but is provided by
 * `TranscriptsModule` — the transcription read model is what notices — with no
 * dependency on `MediaService`, whose module already imports that one.
 */
@Injectable()
export class MediaProbeRestart {
  private readonly logger = new Logger(MediaProbeRestart.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    @Inject(RAW_STORE) private readonly raw: ObjectStore,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  async restart(
    media: ProbeTarget & { readonly projectId: string },
    workspaceId: string,
  ): Promise<ProbeRestartOutcome> {
    try {
      // A clip's mezzanine may only exist in the derived store (see `promoteToRaw`).
      await promoteToRaw(
        { raw: this.raw, derived: this.derived },
        media.storageKey,
        media.mime ?? "video/mp4",
      );
      // Enqueue first: if admission refuses, the asset keeps the state it had
      // rather than being left `uploaded` with nothing coming to move it.
      const probe = await this.jobs.enqueue({
        type: "media.probe",
        workspaceId,
        projectId: media.projectId,
        params: probeJobPayload(media, media.projectId, {
          raw: this.raw.kind,
          derived: this.derived.kind,
        }),
        jobKey: MEDIA_JOB_KEYS.probe(media.id),
        worstCaseTenths: MEDIA_JOB_QUOTES.probeTenths,
        reason: `media.probe · ${media.id} (never probed)`,
      });
      // Conditional, so a probe that already landed is never knocked back.
      await this.prisma.mediaAsset.updateMany({
        where: { id: media.id, status: "ready", hasAudio: null, width: null, proxyKey: null },
        data: { status: "uploaded" },
      });
      this.logger.log(
        { mediaId: media.id, projectId: media.projectId, probeJobId: probe.job.id },
        "sent never-probed media back through the pipeline",
      );
      return "queued";
    } catch (error) {
      if (error instanceof AppException && error.code === JOB_ERROR_CODES.concurrencyCap) {
        // Found live (2026-09-25): three stuck clips repaired at once on a Free
        // workspace — the third met a full lane and was opened with no preview.
        this.logger.log(
          { mediaId: media.id, projectId: media.projectId },
          "workspace lane is full; the probe will be restarted on the next look",
        );
        return "busy";
      }
      this.logger.warn(
        {
          mediaId: media.id,
          projectId: media.projectId,
          error: error instanceof Error ? error.message : String(error),
        },
        "could not restart the probe for never-probed media",
      );
      return "failed";
    }
  }
}

import { Inject, Injectable, Logger } from "@nestjs/common";

import { MEDIA_JOB_KEYS, MEDIA_JOB_QUOTES } from "./media.constants.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { DERIVED_STORE, RAW_STORE } from "../common/storage/index.js";
import { JobsService } from "../jobs/jobs.service.js";

import type { ObjectStore } from "../common/storage/index.js";

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

  /** @returns whether the probe is now queued (or already was). */
  async restart(media: ProbeTarget & { readonly projectId: string }, workspaceId: string): Promise<boolean> {
    try {
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
      return true;
    } catch (error) {
      this.logger.warn(
        {
          mediaId: media.id,
          projectId: media.projectId,
          error: error instanceof Error ? error.message : String(error),
        },
        "could not restart the probe for never-probed media",
      );
      return false;
    }
  }
}

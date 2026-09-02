import { Inject, Injectable, Logger } from "@nestjs/common";

import { PrismaService } from "../common/index.js";
import { DERIVED_STORE, RAW_STORE } from "../common/storage/index.js";
import { PURGE_BATCH } from "../projects/projects.constants.js";

import type { ObjectStore } from "../common/storage/index.js";

export interface PurgeReport {
  /** Media rows whose raw object was deleted this pass. */
  readonly rawPurged: number;
  /** Media rows whose derived objects were deleted this pass. */
  readonly derivedPurged: number;
  /** Objects actually removed from each store. */
  readonly rawObjects: number;
  readonly derivedObjects: number;
  /** Rows the sweep could not finish; they are retried on the next pass. */
  readonly failed: number;
}

export interface PurgeOptions {
  /** Overridable so a test can move time rather than wait a week. */
  readonly now?: Date;
  readonly limit?: number;
}

/**
 * Retention (D47), as a method a scheduler can call.
 *
 * Two independent clocks, and keeping them apart is the whole point:
 *
 * * **`raw_purge_at`** — seven days after upload the original file goes. The
 *   proxy, the 16 kHz audio and the waveform are what the editor actually reads,
 *   so a project stays perfectly usable after its raw media has gone; what is
 *   lost is the ability to re-derive at a different quality.
 * * **`derived_purge_at`** — the plan's retention window. When this passes the
 *   project stops being editable, which is why it is the longer of the two on
 *   every plan.
 *
 * Deleting the object and marking the row are two systems, so the order matters:
 * the object is deleted **first** and `*_purged_at` is written only after the
 * store confirms. A crash in between leaves a row that will be swept again and a
 * delete that is idempotent, which is the harmless direction. The other order
 * would silently strand paid-for storage.
 *
 * **The scheduler wiring is B16's.** This service registers no task: a retention
 * sweep that starts itself in every process — including a developer's laptop
 * pointed at a shared bucket — is how a demo database loses its media.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RAW_STORE) private readonly raw: ObjectStore,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  async purgeDueMedia(options: PurgeOptions = {}): Promise<PurgeReport> {
    const now = options.now ?? new Date();
    const take = options.limit ?? PURGE_BATCH;

    const rawResult = await this.purgeRaw(now, take);
    const derivedResult = await this.purgeDerived(now, take);

    return {
      rawPurged: rawResult.rows,
      derivedPurged: derivedResult.rows,
      rawObjects: rawResult.objects,
      derivedObjects: derivedResult.objects,
      failed: rawResult.failed + derivedResult.failed,
    };
  }

  private async purgeRaw(
    now: Date,
    take: number,
  ): Promise<{ rows: number; objects: number; failed: number }> {
    const due = await this.prisma.mediaAsset.findMany({
      where: {
        rawPurgeAt: { lte: now },
        rawPurgedAt: null,
        // An import has no raw object; its sidecar lives in the derived bucket
        // and is swept by the other half of this service.
        bucket: "s3",
      },
      select: { id: true, storageKey: true },
      orderBy: { rawPurgeAt: "asc" },
      take,
    });

    let objects = 0;
    let failed = 0;
    const purged: string[] = [];

    for (const media of due) {
      try {
        await this.raw.delete(media.storageKey);
        objects += 1;
        purged.push(media.id);
      } catch (error) {
        failed += 1;
        this.logger.warn(
          { mediaId: media.id, err: describe(error) },
          "raw object not purged; will retry",
        );
      }
    }

    if (purged.length > 0) {
      await this.prisma.mediaAsset.updateMany({
        where: { id: { in: purged } },
        data: { rawPurgedAt: now },
      });
    }
    return { rows: purged.length, objects, failed };
  }

  private async purgeDerived(
    now: Date,
    take: number,
  ): Promise<{ rows: number; objects: number; failed: number }> {
    const due = await this.prisma.mediaAsset.findMany({
      where: { derivedPurgeAt: { lte: now }, derivedPurgedAt: null },
      select: {
        id: true,
        bucket: true,
        storageKey: true,
        proxyKey: true,
        audio16kKey: true,
        audio48kKey: true,
        waveformKey: true,
        thumbKeys: true,
      },
      orderBy: { derivedPurgeAt: "asc" },
      take,
    });

    let objects = 0;
    let failed = 0;

    for (const media of due) {
      const keys = [
        media.proxyKey,
        media.audio16kKey,
        media.audio48kKey,
        media.waveformKey,
        ...media.thumbKeys,
        // An imported subtitle IS its own derived object: the row points straight
        // at the sidecar rather than at a raw upload.
        ...(media.bucket === "r2" ? [media.storageKey] : []),
      ].filter((key): key is string => key !== null && key !== "");

      try {
        if (keys.length > 0) objects += await this.derived.deleteMany(keys);
        await this.prisma.mediaAsset.update({
          where: { id: media.id },
          data: {
            derivedPurgedAt: now,
            proxyKey: null,
            audio16kKey: null,
            audio48kKey: null,
            waveformKey: null,
            thumbKeys: [],
            // The bytes are gone in both stores now, so the row can say so.
            ...(media.bucket === "r2" ? { status: "purged" as const } : {}),
          },
        });
      } catch (error) {
        failed += 1;
        this.logger.warn(
          { mediaId: media.id, err: describe(error) },
          "derived objects not purged; will retry",
        );
      }
    }

    const purgedRows = due.length - failed;
    return { rows: purgedRows, objects, failed };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

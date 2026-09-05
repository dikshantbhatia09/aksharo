import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { ulid } from "ulid";
import { z } from "zod";

import { quote } from "@montaj/config";

import { EXPORT_RETENTION_DAYS } from "./exports.constants.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";
import { PartnerCatalogueService } from "../partner-catalogue/partner-catalogue.service.js";
import { reportPartnerUsageForExport } from "../partner-catalogue/usage-emission.js";
import { EXPORT_COMPLETED_EVENT } from "../referrals/export-completed.event.js";

import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";
import type { $Enums } from "@prisma/client";

/**
 * What a `render.video`/`render.subtitle` completion means (A21).
 *
 * `apps/render` is stateless the same way `apps/worker-ai` is (`transcribe.handler.ts`'s
 * doc comment): it never writes a row, and everything that turns its result into
 * an `exports` row a workspace can see happens here.
 *
 * **Idempotency.** The manifest's nonce is claimed with the same conditional
 * `UPDATE … WHERE consumed_at IS NULL` the browser-completion path uses, and it
 * is the *first* write this handler makes. A retry after this handler threw
 * therefore always finds the nonce already claimed, skips re-creating rows, and
 * still returns the correct settlement figure — the one case worth re-running is
 * "the credits were never settled because the first attempt died before
 * returning", and skipping the writes does not skip that.
 */

const ManifestParamsSchema = z.object({
  manifestId: z.string().min(1),
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  exportId: z.string().min(1),
  watermark: z.unknown().nullable(),
  output: z.object({
    width: z.number().int(),
    height: z.number().int(),
    preset: z.string().min(1),
    container: z.string().min(1),
  }),
});

const JobParamsSchema = z.object({ manifest: ManifestParamsSchema });

const RenderVideoResultSchema = z.object({
  exportId: z.string().min(1),
  outputKey: z.string().min(1),
  outputMs: z.number().int().min(0),
  sizeBytes: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  watermarked: z.boolean(),
});

const RenderSubtitleResultSchema = z.object({
  exportId: z.string().min(1),
  outputMs: z.number().int().min(0),
  sidecars: z
    .array(
      z.object({
        format: z.string().min(1),
        script: z.string().min(1),
        key: z.string().min(1),
        sizeBytes: z.number().int().min(0),
        cues: z.number().int().min(0),
      }),
    )
    .default([]),
});

const SUBTITLE_KINDS = new Set(["srt", "vtt", "txt", "md", "ass"]);

function exportKindFor(format: string): $Enums.ExportKind {
  return (SUBTITLE_KINDS.has(format) ? format : "txt") as $Enums.ExportKind;
}

/** Claim the manifest's nonce; `false` means this call is a retry that already claimed it. */
async function claimManifest(prisma: PrismaService, manifestId: string): Promise<boolean> {
  const claimed = await prisma.exportManifest.updateMany({
    where: { id: manifestId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return claimed.count === 1;
}

async function recordPublishEvent(
  prisma: PrismaService,
  events: EventEmitter2,
  workspaceId: string,
  projectId: string,
  exportId: string,
): Promise<void> {
  await prisma.publishEvent.create({
    data: { id: ulid(), workspaceId, projectId, surface: "web", exportId },
  });
  // B07b: the give-get referral loop grants on a workspace's first
  // completed export — see `referrals/export-completed.event.ts`.
  events.emit(EXPORT_COMPLETED_EVENT, { workspaceId, exportId });
}

@Injectable()
export class RenderVideoCompletionHandler implements JobCompletionHandler, OnModuleInit {
  readonly jobType: QueueName = "render.video";
  private readonly logger = new Logger(RenderVideoCompletionHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobCompletionRegistry,
    private readonly events: EventEmitter2,
    private readonly partnerCatalogue: PartnerCatalogueService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome> {
    const { job } = context;
    const params = JobParamsSchema.parse(job.params ?? {});
    const result = RenderVideoResultSchema.parse(context.result);
    const manifest = params.manifest;

    // B02b: `quote()`, not `creditCostTenths` directly — the same helper the
    // reserve side (`exports.service.ts`) and the dialog estimate
    // (`decision.ts`) use, so all three price a render the same way.
    const actualTenths = quote("cloudRender", result.outputMs / 60_000).costTenths;

    const firstTime = await claimManifest(this.prisma, manifest.manifestId);
    if (!firstTime) {
      this.logger.warn(
        { jobId: job.id, manifestId: manifest.manifestId },
        "render.video completion replayed",
      );
      return { actualTenths, data: { exportId: manifest.exportId, replayed: true } };
    }

    await this.prisma.export.upsert({
      where: { id: manifest.exportId },
      create: {
        id: manifest.exportId,
        workspaceId: manifest.workspaceId,
        projectId: manifest.projectId,
        manifestId: manifest.manifestId,
        jobId: job.id,
        status: "succeeded",
        kind: manifest.output.container === "mov" ? "mov" : "mp4",
        preset: manifest.output.preset,
        bucket: "r2",
        storageKey: result.outputKey,
        sizeBytes: BigInt(result.sizeBytes),
        watermarked: result.watermarked,
        resolution: `${String(result.width)}x${String(result.height)}`,
        durationMs: result.outputMs,
        expiresAt: new Date(Date.now() + EXPORT_RETENTION_DAYS * 24 * 60 * 60_000),
      },
      update: {
        status: "succeeded",
        storageKey: result.outputKey,
        sizeBytes: BigInt(result.sizeBytes),
        watermarked: result.watermarked,
        resolution: `${String(result.width)}x${String(result.height)}`,
        durationMs: result.outputMs,
      },
    });

    await recordPublishEvent(
      this.prisma,
      this.events,
      manifest.workspaceId,
      manifest.projectId,
      manifest.exportId,
    );

    // D04b2 scope §3: report usage for every partner asset used in this
    // project's not-yet-exported placements — best-effort, retried by
    // `PartnerUsageReportRetryTask` on failure.
    await reportPartnerUsageForExport(this.prisma, this.partnerCatalogue, this.logger, {
      workspaceId: manifest.workspaceId,
      projectId: manifest.projectId,
      exportId: manifest.exportId,
    });

    this.logger.log(
      { jobId: job.id, exportId: manifest.exportId, outputKey: result.outputKey, actualTenths },
      "cloud video export recorded",
    );

    return {
      actualTenths,
      data: {
        exportId: manifest.exportId,
        outputKey: result.outputKey,
        sizeBytes: result.sizeBytes,
      },
    };
  }
}

@Injectable()
export class RenderSubtitleCompletionHandler implements JobCompletionHandler, OnModuleInit {
  readonly jobType: QueueName = "render.subtitle";
  private readonly logger = new Logger(RenderSubtitleCompletionHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobCompletionRegistry,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome> {
    const { job } = context;
    const params = JobParamsSchema.parse(job.params ?? {});
    const result = RenderSubtitleResultSchema.parse(context.result);
    const manifest = params.manifest;

    const firstTime = await claimManifest(this.prisma, manifest.manifestId);
    if (!firstTime) {
      this.logger.warn(
        { jobId: job.id, manifestId: manifest.manifestId },
        "render.subtitle completion replayed",
      );
      return { actualTenths: 0, data: { exportId: manifest.exportId, replayed: true } };
    }

    // The first sidecar IS the export the client was handed at POST time. The
    // cloud path writes no `exports` row up front (only the manifest), so unless
    // `manifest.exportId` becomes a succeeded row here, the dialog's and the
    // history's download for that id 404 forever — F06's QA found exactly that.
    // Extra sidecars keep their own ids, as before.
    const rows = result.sidecars.map((sidecar, index) => ({
      id: index === 0 ? manifest.exportId : ulid(),
      workspaceId: manifest.workspaceId,
      projectId: manifest.projectId,
      manifestId: manifest.manifestId,
      jobId: job.id,
      status: "succeeded" as const,
      kind: exportKindFor(sidecar.format),
      preset: manifest.output.preset,
      bucket: "r2" as const,
      storageKey: sidecar.key,
      sizeBytes: BigInt(sidecar.sizeBytes),
      watermarked: false,
      resolution: null,
      durationMs: result.outputMs,
      expiresAt: new Date(Date.now() + EXPORT_RETENTION_DAYS * 24 * 60 * 60_000),
    }));

    if (rows.length > 0) {
      await this.prisma.export.createMany({ data: rows });
    }
    await recordPublishEvent(
      this.prisma,
      this.events,
      manifest.workspaceId,
      manifest.projectId,
      manifest.exportId,
    );

    this.logger.log(
      { jobId: job.id, exportId: manifest.exportId, sidecars: rows.length },
      "cloud subtitle export recorded",
    );

    return {
      actualTenths: 0,
      data: { exportId: manifest.exportId, sidecars: rows.length },
    };
  }
}

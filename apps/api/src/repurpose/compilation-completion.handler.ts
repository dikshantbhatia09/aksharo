import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { quote } from "@montaj/config";
import {
  RenderCompilationPayloadSchema,
  RenderCompilationResultSchema,
  compilationExportKey,
} from "@montaj/repurpose-contracts";

import { compilationFailureOf } from "./compilation-plan.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { DERIVED_STORE, type ObjectStore } from "../common/storage/index.js";
import { EXPORT_RETENTION_DAYS } from "../exports/exports.constants.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";

import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";

/**
 * What a `render.compilation` completion means (2026-10-03): the compilation's
 * export is finished - its file, its size, its length, and its seven days,
 * which start now, as for every render - and the compilation reads `ready`.
 *
 * **Held to what was asked.** The same compilation, the same attempt (export)
 * and the key that attempt's export has, so a worker bug cannot file another
 * workspace's object, or an old attempt's file over a newer one.
 *
 * **A compilation deleted, or made again, while it rendered** no longer points
 * at this attempt's export: the file has no owner, so it is deleted and
 * nothing is charged. Otherwise the cloud render rate on the measured minutes.
 *
 * Idempotent: a replay writes the same values again.
 */
@Injectable()
export class RepurposeCompilationCompletionHandler implements JobCompletionHandler, OnModuleInit {
  readonly jobType: QueueName = "render.compilation";
  private readonly logger = new Logger(RepurposeCompilationCompletionHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobCompletionRegistry,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome> {
    const { job } = context;
    const result = RenderCompilationResultSchema.safeParse(context.result);
    if (!result.success) {
      throw new Error(
        `render.compilation returned an invalid result: ${result.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      );
    }
    const asked = RenderCompilationPayloadSchema.safeParse(job.params);
    const made = result.data;
    if (
      !asked.success ||
      made.compilationId !== asked.data.compilationId ||
      made.exportId !== asked.data.exportId ||
      made.outputKey !==
        compilationExportKey({
          workspaceId: job.workspaceId,
          projectId: asked.data.projectId,
          exportId: asked.data.exportId,
        })
    ) {
      this.logger.error(
        { jobId: job.id, compilationId: made.compilationId },
        "render.compilation reported a file it was not asked for; nothing applied",
      );
      return { actualTenths: 0, data: { applied: false, reason: "result_mismatch" } };
    }

    const [compilation, exported] = await Promise.all([
      this.prisma.repurposeCompilation.findFirst({
        where: { id: made.compilationId, exportId: made.exportId },
        select: { id: true },
      }),
      this.prisma.export.findUnique({ where: { id: made.exportId }, select: { id: true } }),
    ]);
    if (compilation === null || exported === null) {
      await this.derived.delete(made.outputKey).catch((error: unknown) => {
        this.logger.warn(
          { jobId: job.id, key: made.outputKey, err: error },
          "could not delete a compilation nobody keeps",
        );
      });
      this.logger.log(
        { jobId: job.id, compilationId: made.compilationId },
        "a compilation was deleted or made again while it rendered; its file is dropped",
      );
      return { actualTenths: 0, data: { applied: false, reason: "compilation_gone" } };
    }

    await this.prisma.export.update({
      where: { id: made.exportId },
      data: {
        status: "succeeded",
        jobId: job.id,
        storageKey: made.outputKey,
        sizeBytes: BigInt(made.sizeBytes),
        durationMs: made.outputMs,
        resolution: `${String(made.width)}x${String(made.height)}`,
        // Retention starts when the file exists (render-completion.handler.ts).
        expiresAt: new Date(Date.now() + EXPORT_RETENTION_DAYS * 24 * 60 * 60_000),
      },
    });
    await this.prisma.repurposeCompilation.updateMany({
      where: { id: made.compilationId, exportId: made.exportId },
      data: { status: "ready", durationMs: made.outputMs, failureCode: null },
    });

    // The same helper every render is priced with (`exports.service.ts`).
    const actualTenths = quote("cloudRender", made.outputMs / 60_000).costTenths;
    this.logger.log(
      { jobId: job.id, compilationId: made.compilationId, outputMs: made.outputMs, actualTenths },
      "compilation filed",
    );
    return {
      actualTenths,
      data: { applied: true, exportId: made.exportId, outputMs: made.outputMs },
    };
  }

  /**
   * A terminal failure (the worker's last attempt, a cancel, a job the reaper
   * settled): the attempt's export and the compilation read failed, with the
   * code the run page has words for. Only while this attempt is still theirs.
   */
  async handleFailure(context: JobCompletionContext): Promise<void> {
    const asked = RenderCompilationPayloadSchema.safeParse(context.job.params);
    if (!asked.success) return;
    const failureCode = compilationFailureOf(context.completion.error?.code);
    await this.prisma.export.updateMany({
      where: { id: asked.data.exportId, status: "rendering" },
      data: { status: "failed" },
    });
    await this.prisma.repurposeCompilation.updateMany({
      where: {
        id: asked.data.compilationId,
        exportId: asked.data.exportId,
        status: "rendering",
      },
      data: { status: "failed", failureCode },
    });
  }
}

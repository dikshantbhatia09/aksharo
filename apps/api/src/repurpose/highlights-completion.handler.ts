import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ulid } from "ulid";

import { HighlightsResultSchema } from "@montaj/repurpose-contracts";

import { RepurposeService } from "./repurpose.service.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";
import { RealtimePublisher } from "../realtime/realtime.publisher.js";

import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";
import type { Prisma } from "@prisma/client";

/**
 * Handles completion of `ai.highlights` jobs (Wave 4).
 * Persists the discovered proposals into `clip_candidates` and advances the run status to `candidates_ready`.
 */
@Injectable()
export class RepurposeHighlightsCompletionHandler implements JobCompletionHandler, OnModuleInit {
  private readonly logger = new Logger(RepurposeHighlightsCompletionHandler.name);

  readonly jobType: QueueName = "ai.highlights";

  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: RepurposeService,
    private readonly registry: JobCompletionRegistry,
    private readonly realtime: RealtimePublisher,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome> {
    const rawResult =
      typeof context.result === "object" && context.result !== null
        ? (context.result as Record<string, unknown>)
        : {};
    const rawJobParams =
      context.job && typeof context.job.params === "object" && context.job.params !== null
        ? (context.job.params as Record<string, unknown>)
        : {};
    const runId =
      (rawResult["runId"] as string | undefined) ??
      (rawJobParams["runId"] as string | undefined);

    if (runId) {
      const run = await this.prisma.repurposeRun.findUnique({
        where: { id: runId },
      });

      if (!run) {
        this.logger.warn({ runId }, "ai.highlights completed for a run that no longer exists");
        return { actualTenths: 0, data: { applied: false, reason: "run_not_found" } };
      }

      if (run.status === "failed" || run.status === "cancelled") {
        this.logger.warn(
          { runId: run.id, status: run.status },
          "ai.highlights completed for a run that is already failed or cancelled; ignoring completion",
        );
        return { actualTenths: 0, data: { applied: false, reason: `run_${run.status}` } };
      }
    }

    const parsed = HighlightsResultSchema.safeParse(context.result);
    if (!parsed.success) {
      throw new Error(
        `ai.highlights returned an invalid result: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      );
    }
    const result = parsed.data;

    const run = await this.prisma.repurposeRun.findUnique({
      where: { id: result.runId },
    });

    if (!run) {
      this.logger.warn(
        { runId: result.runId },
        "ai.highlights completed for a run that no longer exists",
      );
      return { actualTenths: 0, data: { applied: false, reason: "run_not_found" } };
    }

    if (run.status === "failed" || run.status === "cancelled") {
      this.logger.warn(
        { runId: run.id, status: run.status },
        "ai.highlights completed for a run that is already failed or cancelled; ignoring completion",
      );
      return { actualTenths: 0, data: { applied: false, reason: `run_${run.status}` } };
    }

    // Insert candidates
    const candidatesData: Prisma.ClipCandidateCreateManyInput[] = result.proposals.map(
      (proposal, index) => ({
        id: ulid(),
        runId: run.id,
        source: "ai" as const,
        state: "proposed" as const,
        rank: index + 1,
        startMs: proposal.startMs,
        endMs: proposal.endMs,
        startWordId: proposal.startWordId,
        endWordId: proposal.endWordId,
        title: proposal.title,
        transcriptExcerpt: proposal.transcriptExcerpt,
        potentialScore: proposal.potentialScore,
        scoreBreakdown: proposal.scoreBreakdown as unknown as Prisma.InputJsonValue,
        reasons: proposal.reasons as unknown as Prisma.InputJsonValue,
        signals: {} as unknown as Prisma.InputJsonValue,
        signalVersion: 1,
        promptVersion: result.promptVersion,
        model: result.model,
        featureVersion: result.featureVersion,
      }),
    );

    if (candidatesData.length > 0) {
      await this.prisma.clipCandidate.createMany({
        data: candidatesData,
        skipDuplicates: true,
      });
    }

    const updated = await this.prisma.repurposeRun.update({
      where: { id: run.id },
      data: {
        status: "candidates_ready",
        currentStage: "finding_clips",
        progress: 55,
      },
    });

    await this.runs.publishStage(updated);

    this.logger.log(
      { runId: run.id, candidateCount: candidatesData.length },
      "Highlight candidates persisted successfully; run is candidates_ready",
    );

    return {
      data: {
        runId: run.id,
        candidatesCreated: candidatesData.length,
        applied: true,
      },
    };
  }

  async handleFailure(context: JobCompletionContext): Promise<void> {
    const params = context.job.params as Record<string, unknown> | undefined;
    const runId = (params?.["runId"] as string | undefined) ?? "";
    if (!runId) return;

    const run = await this.prisma.repurposeRun.findUnique({ where: { id: runId } });
    if (!run || ["failed", "cancelled", "published"].includes(run.status)) return;

    const failed = await this.prisma.repurposeRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        failureCode: "repurpose/analysis_failed",
      },
    });

    await this.runs.publishStage(failed);
  }
}

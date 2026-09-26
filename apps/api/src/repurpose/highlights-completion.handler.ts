import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ulid } from "ulid";

import { HighlightsResultSchema } from "@montaj/repurpose-contracts";

import { STAGE_OF_FAILURE, runFailureCode } from "./failure-codes.js";
import { PRE_CANDIDATE_STATUSES } from "./repurpose.constants.js";
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
 *
 * Both halves happen together, and only while the run is still waiting for its
 * moments (`PRE_CANDIDATE_STATUSES`): a result that lands after the person
 * stopped the run, or after they already moved on to cutting clips, changes
 * nothing. An empty result is an answer, not a failure — the run is ready with
 * no suggestions, and the page offers adding a moment by its times.
 *
 * The run and transcript are the ones the job was queued for (its params); a
 * result that names others is refused rather than stored against either.
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
    const queued = queuedFor(context);
    // The run the API queued this job for wins over the one the worker names.
    const runId = queued.runId ?? (rawResult["runId"] as string | undefined);

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
    // Moments are stored against the run and transcript the job was queued
    // for (its params, which the API wrote). A worker that mixed up two
    // concurrent discoveries would otherwise put one run's moments — possibly
    // another workspace's words — into another. Refused like a body that does
    // not parse.
    if (
      (queued.runId !== undefined && result.runId !== queued.runId) ||
      (queued.transcriptId !== undefined && result.transcriptId !== queued.transcriptId)
    ) {
      throw new Error(
        `ai.highlights returned moments for run ${result.runId} / transcript ${result.transcriptId}, but job ${context.job.id} was queued for run ${queued.runId ?? "?"} / transcript ${queued.transcriptId ?? "?"}`,
      );
    }

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

    // One transaction: the move is what says "these candidates are the run's
    // moments", so a replay after a crash between the two can never find the
    // run moved on and its candidates missing. The move is conditional, which
    // is what turns away a result for a run that is no longer waiting for one.
    const applied = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.repurposeRun.updateMany({
        where: { id: run.id, status: { in: [...PRE_CANDIDATE_STATUSES] } },
        data: { status: "candidates_ready", currentStage: "finding_clips", progress: 55 },
      });
      if (moved.count === 0) return false;
      if (candidatesData.length > 0) {
        await tx.clipCandidate.createMany({ data: candidatesData, skipDuplicates: true });
      }
      return true;
    });

    if (!applied) {
      this.logger.warn(
        { runId: run.id, status: run.status },
        "ai.highlights completed for a run that has moved on; ignoring completion",
      );
      return { actualTenths: 0, data: { applied: false, reason: "run_moved_on" } };
    }

    const updated = await this.prisma.repurposeRun.findUnique({ where: { id: run.id } });
    if (updated !== null) {
      await this.runs.publishStage(updated, { candidateCount: candidatesData.length });
    }

    this.logger.log(
      { runId: run.id, candidateCount: candidatesData.length },
      "Highlight candidates persisted successfully; run is candidates_ready",
    );
    await this.runs.reconcileRun(run.id);

    return {
      data: {
        runId: run.id,
        candidatesCreated: candidatesData.length,
        applied: true,
      },
    };
  }

  async handleFailure(context: JobCompletionContext): Promise<void> {
    const runId = queuedFor(context).runId;
    if (runId === undefined) return;

    const run = await this.prisma.repurposeRun.findUnique({ where: { id: runId } });
    // `failRun` only fails a run still waiting for its moments; a stopped run,
    // or one already cutting clips, keeps what it has.
    if (!run) return;

    await this.runs.failRun(
      run,
      runFailureCode({
        failedAt: "highlights",
        jobErrorCode: context.completion.error?.code ?? null,
      }),
      STAGE_OF_FAILURE.highlights,
    );
  }
}

/**
 * The run and transcript an `ai.highlights` job was queued for, from its params
 * (`startHighlightDiscovery` writes both). Either is undefined only for a job
 * row that carries no such param.
 */
function queuedFor(context: JobCompletionContext): {
  readonly runId: string | undefined;
  readonly transcriptId: string | undefined;
} {
  const params = context.job.params;
  const record =
    typeof params === "object" && params !== null && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  const runId = record["runId"];
  const transcriptId = record["transcriptId"];
  return {
    runId: typeof runId === "string" && runId !== "" ? runId : undefined,
    transcriptId:
      typeof transcriptId === "string" && transcriptId !== "" ? transcriptId : undefined,
  };
}

import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";

import { newId } from "@montaj/edg";
import type { InsightKind } from "@montaj/prompts";

import { INSIGHT_KIND_TENTHS } from "./insights.quote.js";
import { InsightsRepository } from "./insights.repository.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";
import { retentionClassOf } from "../transcripts/transcribe.handler.js";

import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";
import type { Prisma } from "@prisma/client";

/**
 * What an `ai.llm` completion means (B11): persist the worker's
 * `{templateId, version, provider, region, output, usage}` (CONTRACTS §3) as
 * one `llm_outputs` row, and record every external call as a
 * `provider_submissions` row (same erasure-trail obligation A11's handler
 * follows for transcription).
 */
const LlmResultSchema = z.object({
  templateId: z.enum(["chapters", "summary", "hooks"]),
  version: z.string().min(1),
  provider: z.string().min(1),
  region: z.string().min(1),
  output: z.record(z.string(), z.unknown()),
  usage: z.record(z.string(), z.unknown()).default({}),
  providerSubmissions: z
    .array(
      z.object({
        provider: z.string().min(1).max(64),
        endpoint: z.string().max(512).optional(),
        artefact: z.string().max(256).optional(),
        externalRef: z.string().max(256).optional(),
        region: z.string().max(64).optional(),
        retentionClass: z.string().max(64).optional(),
      }),
    )
    .default([]),
});

@Injectable()
export class InsightsCompletionHandler implements JobCompletionHandler, OnModuleInit {
  readonly jobType: QueueName = "ai.llm";

  private readonly logger = new Logger(InsightsCompletionHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: InsightsRepository,
    private readonly registry: JobCompletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome> {
    const { job } = context;
    const result = LlmResultSchema.parse(context.result);
    const projectId = job.projectId;
    if (projectId === null) {
      throw new Error(`job ${job.id} is an ai.llm with no project`);
    }
    const kind = result.templateId as InsightKind;

    const row = await this.repository.create({
      projectId,
      workspaceId: job.workspaceId,
      jobId: job.id,
      kind,
      templateVersion: result.version,
      provider: result.provider,
      region: result.region,
      output: result.output as Prisma.InputJsonValue,
      usage: result.usage as Prisma.InputJsonValue,
    });

    if (result.providerSubmissions.length > 0) {
      await this.prisma.providerSubmission.createMany({
        data: result.providerSubmissions.map((submission) => ({
          id: newId(),
          jobId: job.id,
          workspaceId: job.workspaceId,
          projectId,
          provider: submission.provider,
          endpoint: submission.endpoint ?? null,
          region: submission.region ?? null,
          externalRef: submission.externalRef ?? null,
          artefactKind: submission.artefact ?? "llm_output",
          retentionClass: retentionClassOf(submission.retentionClass),
        })),
      });
    }

    // Flat per-kind price (`insights.quote.ts`); an `ai.llm` run has no partial
    // settlement the way transcription does, so the hold and the settlement are
    // always the same figure — never more than what was held.
    const actualTenths = Math.min(job.creditsChargedTenths, INSIGHT_KIND_TENTHS[kind]);

    this.logger.log(
      { jobId: job.id, projectId, kind, outputId: row.id, provider: result.provider },
      "insight persisted",
    );

    return {
      actualTenths,
      data: {
        id: row.id,
        kind,
        templateVersion: result.version,
        provider: result.provider,
        region: result.region,
      },
    };
  }
}

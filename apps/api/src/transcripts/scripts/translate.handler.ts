import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";

import { ScriptsService } from "./scripts.service.js";
import { JobCompletionRegistry } from "../../jobs/completion-handlers.js";
import { JobEventsService } from "../../jobs/job-events.service.js";

import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../../jobs/completion-handlers.js";
import type { QueueName } from "../../jobs/contracts/queue-names.js";

/**
 * What an `ai.translate` completion means (A22).
 *
 * The worker already wrote every `SetSegmentText{script: "translated"}` op
 * through the **existing** `POST /internal/projects/{id}/edg/ops` surface
 * (`edg-internal.controller.ts`, unchanged by this work package): that path is
 * revisioned, rebased and published to `project:{id}` exactly like an
 * interactive edit, which is the whole point of reusing it rather than
 * inventing a second write path for translation.
 *
 * What is left for this handler, once the segments already carry the
 * translation:
 *
 * 1. **Record the language tag** (brief: "script key `translated` plus a
 *    language tag recorded on the EDG meta") — `EdgHot.transcript.scripts` has
 *    no per-language slot (CONTRACTS §2 freezes `Segment.textOverrides` as a
 *    flat map with no schema for *which* language `translated` currently
 *    holds), so the tag lives in `meta.engineVersions.translationLanguage`,
 *    the same free-form bag A11 already uses for caption budgets.
 * 2. **Log `transcript.translated`**, the event `GET .../transcript/scripts`
 *    reads back for provenance.
 * 3. **Settle the hold.** The quote is deterministic from the media duration
 *    known at enqueue time (`ScriptsService.translate`), so the hold and the
 *    actual are the same figure — there is nothing the worker could report
 *    that would make this job cheaper or more expensive after the fact.
 */
const TranslateResultSchema = z.object({
  targetLanguage: z.string().min(1).optional(),
  segmentsTranslated: z.number().int().min(0).optional(),
  provider: z.string().min(1).max(64).optional(),
  lengthRetries: z.number().int().min(0).optional(),
  truncated: z.number().int().min(0).optional(),
  applied: z.boolean().optional(),
});

@Injectable()
export class TranslateCompletionHandler implements JobCompletionHandler, OnModuleInit {
  readonly jobType: QueueName = "ai.translate";

  private readonly logger = new Logger(TranslateCompletionHandler.name);

  constructor(
    private readonly scripts: ScriptsService,
    private readonly events: JobEventsService,
    private readonly registry: JobCompletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome> {
    const { job } = context;
    const result = TranslateResultSchema.parse(context.result);

    const projectId = job.projectId;
    const targetLanguage = result.targetLanguage;
    if (projectId !== null && targetLanguage !== undefined) {
      await this.scripts.recordTranslationLanguage(projectId, targetLanguage);
      await this.events.append({
        jobId: job.id,
        name: "transcript.translated",
        message: `${String(result.segmentsTranslated ?? 0)} segments -> ${targetLanguage}`,
        data: {
          script: "translated",
          targetLanguage,
          provider: result.provider,
          segmentsTranslated: result.segmentsTranslated,
          lengthRetries: result.lengthRetries,
          truncated: result.truncated,
        },
      });
    }

    this.logger.log({ jobId: job.id, ...result }, "translation completed");

    return {
      // The quote is deterministic (media duration, known at enqueue) — the
      // hold already equals the actual, so nothing here overrides it.
      data: { ...result },
    };
  }
}

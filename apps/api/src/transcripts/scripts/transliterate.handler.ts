import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";

import { JobCompletionRegistry } from "../../jobs/completion-handlers.js";

import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../../jobs/completion-handlers.js";
import type { QueueName } from "../../jobs/contracts/queue-names.js";

/**
 * What an `ai.transliterate` completion means (A22).
 *
 * Almost nothing, by design. Unlike `ai.transcribe` (`transcribe.handler.ts`),
 * this queue's worker does not carry its result home on the completion
 * payload — it already wrote every `word.scripts` change through
 * `POST /internal/transcripts/{id}/scripts` (`ScriptsService.applyWordScripts`,
 * called from `ScriptsInternalController`), including the `transcript.
 * scripts_updated` job event a "what changed" read wants. By the time this
 * handler runs, the transcript is already correct; it settles the (always
 * zero) credit hold and mirrors the worker's own summary into `job.succeeded`'s
 * `data` for anyone watching the job, and that is all there is to do.
 */
const TransliterateResultSchema = z.object({
  transcriptId: z.string().min(1).optional(),
  targetScript: z.enum(["roman", "native"]).optional(),
  wordsUpdated: z.number().int().min(0).optional(),
  wordsPreserved: z.number().int().min(0).optional(),
  provider: z.string().min(1).max(64).optional(),
  applied: z.boolean().optional(),
});

@Injectable()
export class TransliterateCompletionHandler implements JobCompletionHandler, OnModuleInit {
  readonly jobType: QueueName = "ai.transliterate";

  private readonly logger = new Logger(TransliterateCompletionHandler.name);

  constructor(private readonly registry: JobCompletionRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome> {
    const result = TransliterateResultSchema.parse(context.result);

    this.logger.log(
      { jobId: context.job.id, ...result },
      "transliteration completed (words were already written)",
    );

    return {
      // Free (04 §Credits): the hold was zero tenths, and there is nothing to
      // settle beyond it.
      actualTenths: 0,
      data: { ...result },
    };
  }
}

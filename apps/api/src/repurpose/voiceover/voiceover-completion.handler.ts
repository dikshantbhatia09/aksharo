import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { AiVoiceoverPayloadSchema, AiVoiceoverResultSchema } from "@montaj/repurpose-contracts";

import { RepurposeVoiceoversService } from "./voiceovers.service.js";
import { JobCompletionRegistry } from "../../jobs/completion-handlers.js";

import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../../jobs/completion-handlers.js";
import type { QueueName } from "../../jobs/contracts/queue-names.js";

/**
 * `ai.voiceover` completions (2026-10-01): a clip's hook, spoken and stored.
 *
 * The voice-over is recorded as made and laid on its clip's shapes; the
 * credits the job held settle at the voice-over's price. **Only what was asked
 * for is applied**: the result must name the job's own voice-over and its one
 * key (the service checks the key against the one it derives from the run, not
 * the payload's or the result's word). Anything else is a worker bug or a
 * compromised worker: nothing is placed, the job settles at nothing and the
 * voice-over fails.
 *
 * A failure (`handleFailure`) fails the voice-over with the worker's code.
 * Both paths are idempotent: they only move a voice-over still `speaking`
 * with this job.
 */
@Injectable()
export class RepurposeVoiceoverCompletionHandler implements JobCompletionHandler, OnModuleInit {
  private readonly logger = new Logger(RepurposeVoiceoverCompletionHandler.name);

  readonly jobType: QueueName = "ai.voiceover";

  constructor(
    private readonly voiceovers: RepurposeVoiceoversService,
    private readonly registry: JobCompletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome> {
    const asked = AiVoiceoverPayloadSchema.safeParse(context.job.params);
    if (!asked.success) {
      return { actualTenths: 0, data: { applied: false, reason: "not_a_voiceover" } };
    }
    const parsed = AiVoiceoverResultSchema.safeParse(context.result);
    if (!parsed.success) {
      throw new Error(
        `ai.voiceover returned an invalid result: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      );
    }
    const result = parsed.data;
    const payload = asked.data;
    if (result.voiceoverId !== payload.voiceoverId || result.key !== payload.destination.key) {
      this.logger.error(
        { jobId: context.job.id, voiceoverId: result.voiceoverId, asked: payload.voiceoverId },
        "ai.voiceover reported a file it was not asked for; nothing applied",
      );
      await this.voiceovers.applyJobFailed(payload.voiceoverId, context.job.id, {
        code: "voiceover/result_mismatch",
        message: "another voice-over's file",
      });
      return { actualTenths: 0, data: { applied: false, reason: "result_mismatch" } };
    }
    const tenths = await this.voiceovers.applySpoken(payload.voiceoverId, context.job.id, {
      key: result.key,
      durationMs: result.durationMs,
    });
    this.logger.log(
      { voiceoverId: payload.voiceoverId, durationMs: result.durationMs, reused: result.reused },
      "voice-over made",
    );
    return {
      actualTenths: tenths,
      data: { voiceoverId: payload.voiceoverId, durationMs: result.durationMs },
    };
  }

  async handleFailure(context: JobCompletionContext): Promise<void> {
    const asked = AiVoiceoverPayloadSchema.safeParse(context.job.params);
    if (!asked.success) return;
    const error = context.completion.error;
    await this.voiceovers.applyJobFailed(
      asked.data.voiceoverId,
      context.job.id,
      error === undefined ? null : { code: error.code, message: error.message },
    );
  }
}

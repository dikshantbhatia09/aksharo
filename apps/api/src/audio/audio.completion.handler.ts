import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";

import { PrismaService } from "../common/prisma/prisma.service.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";

import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";

/** `worker_ai.clean.processor.process_clean`'s `result` (CONTRACTS §3). */
const CleanResultSchema = z.object({
  cleanId: z.string().min(1),
  mediaId: z.string().min(1),
  strength: z.enum(["light", "medium", "strong"]),
  target: z.enum(["social", "youtube", "podcast"]),
  dereverb: z.boolean().optional(),
  deesser: z.boolean().optional(),
  storageKeys: z.record(z.string(), z.string()).default({}),
  metrics: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
});

/**
 * What an `ai.clean` completion means (B10): write the worker's metrics and
 * derived-bucket keys onto the \`audio_cleans\` row the producer minted.
 *
 * Unlike \`ai.transcribe\`, nothing here touches the EDG document — applying a
 * clean to the export (\`EdgHot.audio.clean\`, \`SetAudio\`) is a separate,
 * explicit user action from the Audio panel (brief §3 "Apply to export"), not
 * something a finished job does on its own. A clean the user never applies
 * must not silently become the one in the export.
 *
 * Idempotent: every write is a plain \`UPDATE ... WHERE id\`, safe to repeat
 * for an at-least-once callback.
 */
@Injectable()
export class AudioCleanCompletionHandler implements JobCompletionHandler, OnModuleInit {
  readonly jobType: QueueName = "ai.clean";

  private readonly logger = new Logger(AudioCleanCompletionHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobCompletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome | undefined> {
    const result = CleanResultSchema.parse(context.result);

    const row = await this.prisma.audioClean.findUnique({ where: { id: result.cleanId } });
    if (row === null) {
      this.logger.warn(
        { cleanId: result.cleanId, jobId: context.job.id },
        "ai.clean completed for a cleanId with no audio_cleans row",
      );
      return undefined;
    }

    await this.prisma.audioClean.update({
      where: { id: row.id },
      data: {
        status: "succeeded",
        metrics: result.metrics,
        storageKeys: result.storageKeys,
        completedAt: new Date(),
      },
    });

    return { data: { cleanId: row.id, mediaId: result.mediaId } };
  }
}

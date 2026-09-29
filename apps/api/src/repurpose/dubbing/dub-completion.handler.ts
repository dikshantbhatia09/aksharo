import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import {
  AiDubResultSchema,
  DubRunPayloadSchema,
  dubLanguageFolder,
  type DubTrack,
} from "@montaj/repurpose-contracts";

import { RepurposeDubsService } from "./dubs.service.js";
import { JobCompletionRegistry } from "../../jobs/completion-handlers.js";

import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../../jobs/completion-handlers.js";
import type { QueueName } from "../../jobs/contracts/queue-names.js";

/**
 * `ai.dub` completions (2026-10-04): what came back from the dubbing vendor.
 *
 * A dub's files are recorded on the dub and it moves on to its shapes; the
 * credits the job held settle on the languages that came back
 * (`actualTenths`), never on the ones the vendor failed. A cancel job
 * (`action: "cancel"`) records nothing: it held nothing.
 *
 * **Only what was asked for is applied.** The worker reports the dub it
 * dubbed and the keys it wrote; the dub must be the job's, and every key must
 * be inside that dub's own folder for that language (the folder is the job's
 * own payload, not the result's word). Anything else is a worker bug or a
 * compromised worker, and nothing is written: the job settles at nothing and
 * the dub fails.
 *
 * A failure (`handleFailure`) fails the dub with the worker's code, and gives
 * its rupees back when the vendor's job never started. Both paths are
 * idempotent: they only move a dub still `dubbing` with this job.
 */
@Injectable()
export class RepurposeDubCompletionHandler implements JobCompletionHandler, OnModuleInit {
  private readonly logger = new Logger(RepurposeDubCompletionHandler.name);

  readonly jobType: QueueName = "ai.dub";

  constructor(
    private readonly dubs: RepurposeDubsService,
    private readonly registry: JobCompletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome> {
    const asked = DubRunPayloadSchema.safeParse(context.job.params);
    if (!asked.success) {
      // A cancel job, or one this code cannot read: it held nothing to settle.
      return { actualTenths: 0, data: { applied: false, reason: "not_a_dub" } };
    }
    const parsed = AiDubResultSchema.safeParse(context.result);
    if (!parsed.success || parsed.data.action !== "dub") {
      throw new Error(
        `ai.dub returned an invalid result: ${
          parsed.success
            ? "a cancel's result for a dub"
            : parsed.error.issues
                .map((issue) => `${issue.path.join(".")} ${issue.message}`)
                .join("; ")
        }`,
      );
    }
    const result = parsed.data;
    const payload = asked.data;
    const mismatch = mismatchOf(payload, result.dubId, result.tracks);
    if (mismatch !== null) {
      this.logger.error(
        { jobId: context.job.id, dubId: result.dubId, asked: payload.dubId, mismatch },
        "ai.dub reported files it was not asked for; nothing applied",
      );
      await this.dubs.applyJobFailed(
        payload.dubId,
        context.job.id,
        { code: "dub/result_mismatch", message: mismatch },
        context.job.checkpoint,
      );
      return { actualTenths: 0, data: { applied: false, reason: "result_mismatch" } };
    }

    const tenths = await this.dubs.applyDubbed(payload.dubId, context.job.id, {
      vendorJobId: result.vendorJobId,
      tracks: result.tracks,
    });
    const ready = result.tracks.filter((track) => track.status === "ready").length;
    this.logger.log(
      { dubId: payload.dubId, vendorJobId: result.vendorJobId, ready, of: result.tracks.length },
      "dub back from the vendor",
    );
    return {
      actualTenths: tenths,
      data: { dubId: payload.dubId, vendorJobId: result.vendorJobId, languages: ready },
    };
  }

  async handleFailure(context: JobCompletionContext): Promise<void> {
    const asked = DubRunPayloadSchema.safeParse(context.job.params);
    if (!asked.success) return;
    const error = context.completion.error;
    await this.dubs.applyJobFailed(
      asked.data.dubId,
      context.job.id,
      error === undefined ? null : { code: error.code, message: error.message },
      context.job.checkpoint,
    );
  }
}

/** Why a result cannot be applied to the dub its job asked for, or null. */
function mismatchOf(
  payload: {
    readonly dubId: string;
    readonly destinationPrefix: string;
    readonly targetLanguages: readonly string[];
  },
  dubId: string,
  tracks: readonly DubTrack[],
): string | null {
  if (dubId !== payload.dubId) return "another dub's result";
  for (const track of tracks) {
    if (!payload.targetLanguages.includes(track.language))
      return `${track.language} was not asked for`;
    const folder = dubLanguageFolder(payload.destinationPrefix, track.language);
    for (const key of [track.audio?.key, track.captions?.key]) {
      if (key !== undefined && !key.startsWith(folder)) return `a file outside ${folder}`;
    }
  }
  return null;
}

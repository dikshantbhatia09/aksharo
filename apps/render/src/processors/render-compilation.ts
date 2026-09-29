/**
 * The `render.compilation` processor (2026-10-03): a run's clips joined into
 * one video (`compilation/join.ts`), reported through the signed callbacks of
 * CONTRACTS §3 like every render.
 *
 * Refusals are not retried: a payload that does not parse, a clip outside the
 * job's workspace, a video with no picture, or a join past the cap fails the
 * same way every time, so it is reported at once and ends as BullMQ's
 * `UnrecoverableError`. A clip whose file cannot be read is retried once (a
 * store that blinked), and then reported as `storage/unreadable`, which the run
 * page reads as "a clip's video changed; make it again".
 *
 * **A failure is reported only when it is the last word.** The API settles a
 * job on its first failed completion, so an attempt that posted one and was
 * then retried would make its video for nobody: the retry's success would be
 * refused as already completed. Only the final attempt, or a refusal, reports.
 */

import { UnrecoverableError } from "bullmq";
import { ZodError } from "zod";

import { classifyError } from "./render-video.js";
import { renderCompilation, type CompilationDependencies } from "../compilation/join.js";
import { logger } from "../logger.js";
import { isJobEnvelope, RenderCompilationPayloadSchema } from "../queues.js";

import type { CallbackClient, JobError } from "../callbacks.js";
import type { RenderCompilationResult } from "../queues.js";
import type { Job } from "bullmq";

export interface CompilationProcessorContext {
  readonly dependencies: Omit<CompilationDependencies, "onProgress" | "onWarning" | "signal">;
  readonly callbacks: CallbackClient;
  readonly progressIntervalMs: number;
}

/** Codes a compilation can end on that another attempt would only repeat. */
const TERMINAL: ReadonlySet<string> = new Set([
  "render/bad-payload",
  "render/compilation-too-long",
  "render/no-video-stream",
]);

export function classifyCompilationError(error: unknown): JobError {
  if (error instanceof ZodError) {
    return {
      code: "render/bad-payload",
      message: `the render.compilation payload does not parse: ${error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
      retryable: false,
    };
  }
  const classified = classifyError(error);
  return TERMINAL.has(classified.code) ? { ...classified, retryable: false } : classified;
}

export async function processRenderCompilation(
  job: Job,
  context: CompilationProcessorContext,
): Promise<RenderCompilationResult> {
  if (!isJobEnvelope(job.data)) {
    throw new Error(
      `Job ${job.id ?? "?"} on ${job.queueName} does not match the CONTRACTS §3 envelope.`,
    );
  }
  const envelope = job.data;
  const fields = {
    jobId: envelope.jobId,
    attemptId: envelope.attemptId,
    workspaceId: envelope.workspaceId,
    bullJobId: job.id,
  };
  logger.info("render.compilation received", fields);
  const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

  // The first beat promotes the row to running; after it, at most one a
  // `progressIntervalMs`, which the heartbeat interval already bounds.
  let lastBeat = 0;
  const beat = (fraction: number, message: string, force = false): void => {
    const at = Date.now();
    if (!force && at - lastBeat < context.progressIntervalMs) return;
    lastBeat = at;
    void job.updateProgress(Math.round(fraction * 100));
    void context.callbacks
      .progress(envelope.jobId, envelope.attemptId, fraction * 100, { message })
      .catch((error: unknown) => {
        logger.warn("progress callback failed", {
          ...fields,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  try {
    const payload = RenderCompilationPayloadSchema.parse(envelope.payload);
    beat(0, "joining clips", true);
    const outcome = await renderCompilation(payload, envelope.workspaceId, {
      ...context.dependencies,
      onProgress: (fraction, message) => {
        beat(fraction, message);
      },
      onWarning: (message) => {
        logger.warn(message, fields);
      },
    });

    await context.callbacks.complete(envelope.jobId, envelope.attemptId, {
      status: "succeeded",
      result: { ...outcome.result },
      usage: {
        outputSeconds: outcome.result.outputMs / 1000,
        provider: "self",
        model: "libx264",
        // R2 charges nothing for egress (D35), as for every render.
        egressBytes: 0,
      },
      finalAttempt,
    });
    logger.info("render.compilation completed", {
      ...fields,
      outputKey: outcome.result.outputKey,
      outputMs: outcome.result.outputMs,
      clips: outcome.result.clips,
      pieces: outcome.pieces,
      wallClockSeconds: Math.round(outcome.wallClockMs) / 1000,
    });
    return outcome.result;
  } catch (error) {
    const jobError = classifyCompilationError(error);
    const terminal = finalAttempt || !jobError.retryable;
    logger.error("render.compilation failed", { ...fields, ...jobError, terminal });
    if (terminal) {
      await context.callbacks
        .complete(envelope.jobId, envelope.attemptId, {
          status: "failed",
          error: jobError,
          finalAttempt: true,
        })
        .catch((callbackError: unknown) => {
          logger.error("completion callback failed", {
            ...fields,
            error: callbackError instanceof Error ? callbackError.message : String(callbackError),
          });
        });
    }
    if (!jobError.retryable) {
      const unrecoverable = new UnrecoverableError(jobError.message);
      unrecoverable.cause = error;
      throw unrecoverable;
    }
    throw error;
  }
}

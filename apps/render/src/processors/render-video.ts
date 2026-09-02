/**
 * The `render.video` processor.
 *
 * Its job is the wiring, not the rendering: parse the envelope, hand the payload
 * to `renderVideo`, keep the heartbeat going, and report the result — or the
 * refusal — through the signed callback of CONTRACTS §3.
 *
 * **Refusals are not retries.** A manifest with a bad signature, an expired one,
 * or a render that exceeds its plan will fail identically on every attempt, so
 * they complete with `retryable: false` and go straight to the dead-letter table
 * where a human can see them. A download that timed out is retryable and is left
 * to BullMQ's two attempts.
 */

import { isRenderManifestError } from "@montaj/render-manifest";

import { logger } from "../logger.js";
import { isJobEnvelope, RenderVideoPayloadSchema } from "../queues.js";
import { renderVideo, type RenderDependencies } from "../render/pipeline.js";
import { parseStyleCatalogue } from "../render/projection.js";

import type { CallbackClient, JobError } from "../callbacks.js";
import type { RenderVideoPayload, RenderVideoResult } from "../queues.js";
import type { Job } from "bullmq";

/**
 * Every `styleRef` this render's captions actually use — the manifest's
 * default plus each segment's own override — that is **not** `assRenderable`
 * per the payload's own style documents (A18a's parity gate is the only
 * writer of that flag, D33). Empty means the `ass` path's capability
 * precondition is satisfied; a bad/unparseable style document counts as
 * "not renderable" rather than throwing here, so the caller gets one clear
 * `render/unsupported-output` refusal instead of a schema error.
 */
export function unrenderableStylesUsed(payload: RenderVideoPayload): string[] {
  let catalogue: Map<string, unknown>;
  try {
    catalogue = parseStyleCatalogue(payload.styles);
  } catch {
    return [payload.manifest.styles.defaultStyleId];
  }
  const refs = new Set<string>([payload.manifest.styles.defaultStyleId]);
  for (const segment of payload.projection.segments) {
    if (segment.styleRef !== undefined) refs.add(segment.styleRef);
  }
  const unrenderable: string[] = [];
  for (const ref of refs) {
    const doc = catalogue.get(ref) as { assRenderable?: unknown } | undefined;
    if (doc?.assRenderable !== true) unrenderable.push(ref);
  }
  return unrenderable;
}

export interface ProcessorContext {
  readonly dependencies: Omit<RenderDependencies, "onProgress">;
  readonly callbacks: CallbackClient;
  readonly progressIntervalMs: number;
}

/**
 * Errors that will fail the same way on the next attempt.
 *
 * Everything a manifest can be wrong about, plus the caps refusal, plus a
 * projection or style document the payload got wrong. A retry of any of these
 * burns a render slot to reach the same conclusion.
 */
export function classifyError(error: unknown): JobError {
  if (isRenderManifestError(error)) {
    return { code: error.code, message: error.message, retryable: false };
  }
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof code === "string") {
    const terminal = new Set([
      "render/bad-style",
      "render/bad-projection",
      "render/unsupported-output",
      "render/no-audio-source",
      "render/no-video-stream",
      "render/unsupported-subtitle-format",
      "render/bad-font-pack",
      "render/font-file-missing",
      "storage/bad-key",
      "skia-node/no-shaper",
      "skia-node/unsupported-command",
    ]);
    return { code, message, retryable: !terminal.has(code) };
  }
  return { code: "render/failed", message, retryable: true };
}

export async function processRenderVideo(
  job: Job,
  context: ProcessorContext,
): Promise<RenderVideoResult> {
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
  logger.info("render.video received", fields);

  const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

  try {
    const payload = RenderVideoPayloadSchema.parse(envelope.payload);
    if (payload.path === "ass") {
      // `05 §5.2` keeps an ASS fast path for the styles A18a's parity gate has
      // proved `assRenderable` (D33): a real, measured SSIM/pixel-diff against
      // libass, not a hand-set flag. Refuse unless *every* style this render's
      // captions actually reference — the manifest's default plus each
      // segment's own `styleRef` — carries `assRenderable: true`; a producer
      // asking for a style that has not passed the gate is a producer bug,
      // exactly as asking for a style the gate has never seen is.
      //
      // Burning the sidecar into pixels (ffmpeg `-vf ass=`, bypassing the Skia
      // pipeline entirely, which is the whole point of the fast path) is
      // `render/pipeline.ts`'s own machinery (A20) — encoder selection,
      // watermark honesty under THREAT-MODEL T10, audio-replace, alpha output
      // — and stays out of A18a's file boundary (`packages/ass-exporter/**`,
      // `packages/caption-styles/styles/*.json`, the parity CI workflow).
      // A18a's job here is the capability check the fast path is gated on;
      // wiring the actual libass burn-in is A20/A21 follow-up work.
      const unrenderable = unrenderableStylesUsed(payload);
      if (unrenderable.length === 0) {
        throw Object.assign(
          new Error(
            "every referenced style is assRenderable, but the ass burn-in pipeline (ffmpeg -vf ass=, replacing the Skia frame path) is not wired yet — a follow-up to A20/A21, not A18a's own file boundary",
          ),
          { code: "render/unsupported-output" },
        );
      }
      throw Object.assign(
        new Error(
          `the ass render path needs every referenced style to be assRenderable (A18a's parity gate); not yet true for: ${unrenderable.join(", ")}`,
        ),
        { code: "render/unsupported-output" },
      );
    }

    const outcome = await renderVideo(payload, envelope.workspaceId, {
      ...context.dependencies,
      progressIntervalMs: context.progressIntervalMs,
      onProgress: (fraction, message) => {
        void job.updateProgress(Math.round(fraction * 100));
        void context.callbacks
          .progress(envelope.jobId, envelope.attemptId, fraction * 100, { message })
          .catch((error: unknown) => {
            // A missed heartbeat is not a reason to abandon a render that is
            // working; the lock has two more beats of slack (A08b).
            logger.warn("progress callback failed", {
              ...fields,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      },
      onWarning: (message) => {
        logger.warn(message, fields);
      },
    });

    const result: RenderVideoResult = {
      exportId: outcome.manifest.exportId,
      outputKey: outcome.outputKey,
      outputMs: outcome.outputDurationMs,
      sizeBytes: outcome.sizeBytes,
      width: outcome.manifest.output.width,
      height: outcome.manifest.output.height,
      fps: outcome.manifest.output.fps,
      videoCodec: outcome.manifest.output.videoCodec,
      frames: outcome.frames.requested,
      framesRendered: outcome.frames.rasterised,
      renderedAt: new Date().toISOString(),
      watermarked: outcome.manifest.watermark !== null,
      wallClockSeconds: Math.round(outcome.wallClockMs) / 1000,
    };

    await context.callbacks.complete(envelope.jobId, envelope.attemptId, {
      status: "succeeded",
      result: { ...result },
      usage: {
        outputSeconds: outcome.outputDurationMs / 1000,
        mediaSeconds: outcome.manifest.source.durationMs / 1000,
        provider: "self",
        model: outcome.manifest.output.videoCodec,
        // R2 charges nothing for egress (D35), and this is the number that says
        // so in the cost rollup rather than an omission that looks like one.
        egressBytes: 0,
      },
      finalAttempt,
    });

    logger.info("render.video completed", {
      ...fields,
      outputKey: result.outputKey,
      outputMs: result.outputMs,
      frames: result.frames,
      framesRendered: result.framesRendered,
      wallClockSeconds: result.wallClockSeconds,
      ffmpeg: outcome.ffmpegSummary,
    });
    return result;
  } catch (error) {
    const jobError = classifyError(error);
    logger.error("render.video failed", { ...fields, ...jobError });
    await context.callbacks
      .complete(envelope.jobId, envelope.attemptId, {
        status: "failed",
        error: jobError,
        finalAttempt: finalAttempt || !jobError.retryable,
      })
      .catch((callbackError: unknown) => {
        logger.error("completion callback failed", {
          ...fields,
          error: callbackError instanceof Error ? callbackError.message : String(callbackError),
        });
      });
    throw error;
  }
}

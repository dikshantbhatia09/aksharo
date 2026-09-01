import { logger } from "../logger.js";
import { isJobEnvelope } from "../queues.js";

import type { RenderVideoPayload, RenderVideoResult } from "../queues.js";
import type { Job } from "bullmq";

/**
 * `render.video` processor — STUB.
 *
 * A20 replaces the body: `@montaj/render-core` produces `DrawCommand[]`,
 * `@montaj/render-skia-node` rasterises them to RGBA overlay frames, and ffmpeg
 * overlays and encodes with x264 straight to R2. The same `DrawCommand[]` runs
 * in the browser through CanvasKit, which is what the parity gate compares.
 */
export async function processRenderVideo(job: Job): Promise<RenderVideoResult> {
  if (!isJobEnvelope(job.data)) {
    throw new Error(
      `Job ${job.id ?? "?"} on ${job.queueName} does not match the CONTRACTS section 3 envelope.`,
    );
  }

  const envelope = job.data;
  const payload = envelope.payload as Partial<RenderVideoPayload>;

  logger.info("render.video received", {
    jobId: envelope.jobId,
    attemptId: envelope.attemptId,
    workspaceId: envelope.workspaceId,
    exportId: payload.exportId,
    bullJobId: job.id,
  });

  await job.updateProgress(100);

  const result: RenderVideoResult = {
    exportId: payload.exportId ?? "unknown",
    outputKey: null,
    outputMs: null,
    renderedAt: new Date().toISOString(),
    stub: true,
  };

  logger.info("render.video completed (stub)", { jobId: envelope.jobId, result });
  return result;
}

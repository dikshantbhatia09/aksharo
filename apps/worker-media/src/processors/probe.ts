import { logger } from "../logger.js";
import { isJobEnvelope } from "../queues.js";

import type { MediaProbePayload, MediaProbeResult } from "../queues.js";
import type { Job } from "bullmq";

/**
 * `media.probe` processor — STUB.
 *
 * A07 replaces the body with the real work: `ffprobe -show_streams`, duration,
 * fps, dimensions, codecs and channel layout written back through the signed
 * completion callback (CONTRACTS section 3). A01 proves the wiring: a job is
 * received, validated against the envelope contract, logged and completed.
 */
export async function processProbe(job: Job): Promise<MediaProbeResult> {
  if (!isJobEnvelope(job.data)) {
    // Malformed jobs are a producer bug: fail fast rather than retrying forever.
    throw new Error(
      `Job ${job.id ?? "?"} on ${job.queueName} does not match the CONTRACTS section 3 envelope.`,
    );
  }

  const envelope = job.data;
  const payload = envelope.payload as Partial<MediaProbePayload>;

  logger.info("media.probe received", {
    jobId: envelope.jobId,
    attemptId: envelope.attemptId,
    workspaceId: envelope.workspaceId,
    projectId: envelope.projectId,
    mediaId: payload.mediaId,
    bullJobId: job.id,
  });

  await job.updateProgress(100);

  const result: MediaProbeResult = {
    mediaId: payload.mediaId ?? "unknown",
    durationMs: null,
    probedAt: new Date().toISOString(),
    stub: true,
  };

  logger.info("media.probe completed (stub)", { jobId: envelope.jobId, result });
  return result;
}

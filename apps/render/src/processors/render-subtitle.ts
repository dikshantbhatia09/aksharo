/**
 * The `render.subtitle` processor: sidecars, no pixels.
 *
 * It shares the manifest, the projection and the timemap with `render.video`,
 * which is the point — a `.srt` written next to an export has to agree with the
 * captions burned into it, and the only way to guarantee that is for both to
 * read the same snapshot through the same time mapping (D30).
 *
 * One file per (format × script), written to R2 under CONTRACTS §6's export
 * prefix.
 */

import { isRenderManifestError, verifyRenderManifest } from "@montaj/render-manifest";

import { logger } from "../logger.js";
import { isJobEnvelope, RenderSubtitlePayloadSchema } from "../queues.js";
import { buildRenderTimeMap } from "../render/projection.js";
import { contentTypeFor, subtitleKey, type ObjectStore } from "../storage.js";
import { buildCues, isSupportedFormat, renderSidecar, SubtitleError } from "../subtitles.js";
import { classifyError } from "./render-video.js";

import type { CallbackClient } from "../callbacks.js";
import type { RenderSubtitleResult } from "../queues.js";
import type { Job } from "bullmq";

export interface SubtitleContext {
  readonly derivedStore: ObjectStore;
  readonly callbacks: CallbackClient;
  readonly secret: string;
  readonly secretNext?: string | undefined;
  readonly now?: () => number;
}

export async function processRenderSubtitle(
  job: Job,
  context: SubtitleContext,
): Promise<RenderSubtitleResult> {
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
  logger.info("render.subtitle received", fields);

  const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

  try {
    const payload = RenderSubtitlePayloadSchema.parse(envelope.payload);
    const { manifest } = verifyRenderManifest({
      manifest: payload.manifest,
      secret: context.secret,
      secretNext: context.secretNext,
      now: (context.now ?? Date.now)(),
    });
    if (manifest.workspaceId !== envelope.workspaceId) {
      throw new Error(
        `the manifest is for workspace ${manifest.workspaceId}, but the job is for ${envelope.workspaceId}`,
      );
    }
    if (manifest.subtitles === null) {
      throw new SubtitleError(
        "render/unsupported-subtitle-format",
        "this manifest asks for no sidecars; a render.subtitle job needs a subtitles block",
      );
    }

    const timemap = buildRenderTimeMap(manifest);
    const sidecars: RenderSubtitleResult["sidecars"][number][] = [];

    for (const script of manifest.subtitles.scripts) {
      const cues = buildCues({
        projection: payload.projection,
        timemap,
        script,
        dropFillers: manifest.subtitles.dropFillers,
      });
      for (const format of manifest.subtitles.formats) {
        if (!isSupportedFormat(format)) {
          throw new SubtitleError(
            "render/unsupported-subtitle-format",
            `${format} sidecars are written by @montaj/ass-exporter, which lands in A18a`,
          );
        }
        const body = renderSidecar(format, cues);
        const key = subtitleKey(
          manifest.workspaceId,
          manifest.projectId,
          manifest.exportId,
          script,
          format,
        );
        const bytes = Buffer.from(body, "utf8");
        const sizeBytes = await context.derivedStore.putBytes(key, bytes, {
          contentType: contentTypeFor(format),
        });
        sidecars.push({ format, script, key, sizeBytes, cues: cues.length });
      }
    }

    const result: RenderSubtitleResult = {
      exportId: manifest.exportId,
      sidecars,
      outputMs: timemap.outputDurationMs,
      renderedAt: new Date().toISOString(),
    };

    await job.updateProgress(100);
    await context.callbacks.complete(envelope.jobId, envelope.attemptId, {
      status: "succeeded",
      result: { ...result, sidecars: [...sidecars] },
      usage: { outputSeconds: timemap.outputDurationMs / 1000, egressBytes: 0 },
      finalAttempt,
    });

    logger.info("render.subtitle completed", { ...fields, sidecars: sidecars.length });
    return result;
  } catch (error) {
    const jobError = isRenderManifestError(error)
      ? { code: error.code, message: error.message, retryable: false }
      : classifyError(error);
    logger.error("render.subtitle failed", { ...fields, ...jobError });
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

import { ffprobe, readProbe } from "../ffmpeg/ffprobe.js";
import { EMPTY_LOUDNESS, measureLoudness } from "../ffmpeg/loudness.js";
import { toolVersion } from "../media-tools.js";

import type { ProbeResult } from "../probe-result.js";
import type { JobContext, ProcessorOutcome } from "../runtime.js";

/**
 * `media.probe` — what is in this file?
 *
 * ```
 * presign a read of the raw object   (no bytes touch this process)
 *   -> ffprobe -show_format -show_streams        ~ a few range requests
 *   -> ffmpeg -vn -af ebur128,silencedetect      ~ one audio-only decode
 *   -> PATCH /internal/media/{id}                 the measured facts
 *   -> POST  /internal/jobs/{id}/complete         the full result
 * ```
 *
 * **The source is never downloaded.** ffprobe reads it through a presigned URL and
 * asks for the container header and the index; the frames are never fetched. That
 * is what makes probing a 4K sixty-minute upload cost kilobytes of transfer and
 * nothing at all in memory, and it is why this processor has no scratch directory.
 *
 * The loudness pass is the one part that does read the whole audio track, which is
 * a decode of one stream at 1/50th the data rate of the video. It is never fatal:
 * a file whose duration, resolution and codec are all perfectly readable does not
 * become an unusable upload because the loudness meter was unhappy.
 *
 * What happens *next* is not decided here. The API's completion handler applies
 * the plan's duration cap and enqueues `media.proxy` as a child job — because a
 * cap is policy, and policy does not belong in a worker that any pod can run.
 */
export async function processProbe(context: JobContext): Promise<ProcessorOutcome> {
  const { settings, payload } = context;

  const source = await context.raw.presignGet(payload.key, settings.sourceUrlTtlSeconds);
  context.report(5, "reading the container");

  const output = await ffprobe({
    binary: settings.ffprobePath,
    source,
    timeoutMs: settings.ffmpegTimeoutMs,
    signal: context.signal,
  });
  const container = readProbe(output);
  context.report(40, "measuring loudness");

  const loudness =
    settings.loudnessEnabled && container.audio !== null
      ? await measureLoudness({
          binary: settings.ffmpegPath,
          source,
          durationMs: container.durationMs,
          timeoutMs: settings.ffmpegTimeoutMs,
          signal: context.signal,
        })
      : EMPTY_LOUDNESS;
  context.report(90, "reporting");

  const result: ProbeResult = {
    mediaId: payload.mediaId,
    container: container.container,
    mime: container.mime,
    durationMs: container.durationMs,
    sizeBytes: container.sizeBytes ?? payload.sizeBytes ?? null,
    hasVideo: container.video !== null,
    hasAudio: container.audio !== null,
    video: container.video,
    audio: container.audio === null ? null : { ...container.audio, ...loudness },
    probedAt: new Date().toISOString(),
    toolVersion: await toolVersion("ffprobe", settings.ffprobePath),
  };

  return {
    result,
    // Only the facts the row has columns for. `status` stays with the API: the
    // completion handler decides between `probing` and `failed` once it has
    // applied the plan's duration cap.
    mediaPatch: {
      durationMs: result.durationMs,
      hasAudio: result.hasAudio,
      ...(container.mime === null ? {} : { mime: container.mime }),
      ...(container.video === null
        ? {}
        : {
            width: container.video.width,
            height: container.video.height,
            fps: container.video.fps,
            codec: container.video.codec,
            hdr: container.video.hdr,
          }),
      ...(container.audio === null
        ? {}
        : {
            audioChannels: container.audio.channels,
            ...(container.video === null ? { codec: container.audio.codec } : {}),
          }),
    },
    usage: { mediaSeconds: result.durationMs / 1000 },
  };
}

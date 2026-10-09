import { mkdir } from "node:fs/promises";

import { describeError } from "../errors.js";
import {
  ASR_SAMPLE_RATE,
  MASTER_SAMPLE_RATE,
  encodeProxy,
  extractAudio,
  grabThumbnail,
  proxySize,
  thumbnailCount,
  thumbnailOffsetMs,
} from "../ffmpeg/derive.js";
import { ffprobe, readAudioStreams, readProbe } from "../ffmpeg/ffprobe.js";
import { logger } from "../logger.js";
import { derivedKey, thumbKey } from "../storage-keys.js";
import { DERIVED_CONTENT_TYPES, DERIVED_OBJECT_TAGS } from "../storage.js";
import { buildWaveform } from "../waveform.js";
import { withWorkspace } from "../workspace.js";
import { demuxAudioTracks } from "./demux-audio.js";

import type { DeriveContext } from "../ffmpeg/derive.js";
import type { ProbeAudioStream } from "../ffmpeg/ffprobe.js";
import type { ProxyResult } from "../probe-result.js";
import type { MediaProxyPayload } from "../queues.js";
import type { JobContext, ProcessorOutcome } from "../runtime.js";

/**
 * `media.proxy` — everything the editor reads instead of the original.
 *
 * ```
 * presign a read of the raw object
 *   -> audio16k.wav   mono 16 kHz PCM        (ASR and alignment)
 *        -> PATCH /internal/media/{id} { audio16kKey }   (no status; not awaited)
 *   -> audio48k.wav   mono 48 kHz PCM        (mastering, 09 §5)
 *   -> waveform.json  from the 16 kHz PCM    (streamed, never buffered)
 *   -> proxy540.mp4   540p CRF 28 faststart  (tone-mapped when HDR)
 *   -> thumb-{0..n}.jpg  10-32 input-seeks   (a filmstrip, `thumbnailCount`)
 *   -> PATCH /internal/media/{id} { ...keys, status: "ready" }
 * ```
 *
 * The order is not arbitrary. **Audio first**, because it is the cheapest output
 * and the one the rest of the pipeline is waiting on: `ai.transcribe` needs
 * nothing but `audio16k.wav`, and finishing it before a five-minute video encode
 * starts is minutes off the time-to-first-caption. The waveform comes straight
 * after because it is computed from a file that is already on disk. The proxy and
 * the thumbnails — the expensive half — come last.
 *
 * **The API hears about the ASR audio the moment it is stored**, not when the
 * whole job ends ({@link announceAudio}). Writing the key only at the end left
 * transcription idle behind the 540p encode it does not read: 111 s on a
 * 35-minute source (measured 2026-09-27), about fifteen minutes on a three-hour
 * one. With the key on the row, the API can start `ai.transcribe` on the GPU
 * while this job encodes on the CPU. The early write carries no status — `ready`
 * still means every artefact below exists — and the final write-back repeats the
 * key, so an early write that never lands costs only the head start.
 *
 * **Audio-only inputs skip the video half entirely.** No proxy, no thumbnails; a
 * podcast upload is `ready` once its two WAVs and its waveform exist, and the
 * editor draws the waveform where the video would have been. CONTRACTS §6
 * enumerates no poster key, so `thumbKeys` is simply empty and a client that wants
 * a poster uses `thumb-0.jpg` when there is one.
 *
 * Every output lands in a scratch directory that `withWorkspace` deletes in a
 * `finally`, and is uploaded as it is produced rather than at the end, so a
 * failure in the encode does not throw away audio that was already good. The keys
 * are exactly CONTRACTS §6 and are rebuilt from the envelope's ids, so the API's
 * prefix check on `PATCH /internal/media/{id}` accepts them by construction.
 */
export async function processProxy(context: JobContext): Promise<ProcessorOutcome> {
  const { settings, derivedPrefix } = context;
  const payload = context.payload as MediaProxyPayload;

  const source = await context.raw.presignGet(payload.key, settings.sourceUrlTtlSeconds);
  const derive: DeriveContext = {
    binary: settings.ffmpegPath,
    source,
    timeoutMs: settings.ffmpegTimeoutMs,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  };

  // The payload's measurements are a hint the probe left; a job replayed from the
  // dead-letter queue months later may carry none, so they are verified rather
  // than trusted.
  const facts = await resolveFacts(context, payload);

  return withWorkspace("proxy", settings.tempDir, async (workspace) => {
    const keys: {
      proxyKey: string | null;
      audio16kKey: string | null;
      audio48kKey: string | null;
      waveformKey: string | null;
      thumbKeys: string[];
    } = {
      proxyKey: null,
      audio16kKey: null,
      audio48kKey: null,
      waveformKey: null,
      thumbKeys: [],
    };
    const audioTracks: Array<{
      streamIndex: number;
      channelIndex: number;
      label: string;
      audioWavKey: string;
      durationMs: number;
      isDialogue: boolean;
      speakerName: string;
    }> = [];
    let bytesWritten = 0;
    // The early write-back of the ASR audio, in flight alongside the rest of
    // the job. Never rejects; awaited before the job returns (see below).
    let announced: Promise<void> = Promise.resolve();

    // --- audio ------------------------------------------------------------
    if (facts.hasAudio) {
      context.report(5, "extracting 16 kHz audio");
      const asr = workspace.path("audio16k.wav");
      await extractAudio(derive, ASR_SAMPLE_RATE, asr, { clean: true });
      keys.audio16kKey = derivedKey(derivedPrefix, "audio16k.wav");
      bytesWritten += await context.derived.putFile({
        key: keys.audio16kKey,
        file: asr,
        contentType: DERIVED_CONTENT_TYPES["audio16k.wav"],
        tags: DERIVED_OBJECT_TAGS,
      });
      // Only now: the key must name an object that exists when the API reads
      // it, because transcription may be queued off it within the second.
      announced = announceAudio(context, payload.mediaId, keys.audio16kKey);

      context.report(20, "extracting 48 kHz audio");
      const master = workspace.path("audio48k.wav");
      await extractAudio(derive, MASTER_SAMPLE_RATE, master);
      keys.audio48kKey = derivedKey(derivedPrefix, "audio48k.wav");
      bytesWritten += await context.derived.putFile({
        key: keys.audio48kKey,
        file: master,
        contentType: DERIVED_CONTENT_TYPES["audio48k.wav"],
        tags: DERIVED_OBJECT_TAGS,
      });

      // --- waveform -------------------------------------------------------
      context.report(30, "building the waveform");
      const waveform = await buildWaveform({
        file: asr,
        mediaId: payload.mediaId,
        sampleRate: ASR_SAMPLE_RATE,
        durationMs: facts.durationMs,
      });
      const body = Buffer.from(JSON.stringify(waveform), "utf8");
      keys.waveformKey = derivedKey(derivedPrefix, "waveform.json");
      bytesWritten += await context.derived.putBody({
        key: keys.waveformKey,
        body,
        contentType: DERIVED_CONTENT_TYPES["waveform.json"],
        tags: DERIVED_OBJECT_TAGS,
      });

      // --- multi-track audio demuxing ---------------------------------------
      if (
        facts.audioStreams &&
        (facts.audioStreams.length > 1 ||
          (facts.audioStreams.length === 1 && (facts.audioStreams[0]?.channels ?? 0) > 1))
      ) {
        context.report(35, "demuxing multi-track audio channels");
        try {
          const tracksDir = workspace.path("tracks");
          await mkdir(tracksDir, { recursive: true });
          const demuxed = await demuxAudioTracks({
            binary: settings.ffmpegPath,
            source: derive.source,
            audioStreams: facts.audioStreams,
            durationMs: facts.durationMs,
            outDir: tracksDir,
            derivedPrefix,
            timeoutMs: settings.ffmpegTimeoutMs,
            signal: context.signal,
          });

          for (const track of demuxed) {
            bytesWritten += await context.derived.putFile({
              key: track.audioWavKey,
              file: track.localPath,
              contentType: DERIVED_CONTENT_TYPES["audio16k.wav"],
              tags: DERIVED_OBJECT_TAGS,
            });
            audioTracks.push({
              streamIndex: track.streamIndex,
              channelIndex: track.channelIndex,
              label: track.label,
              audioWavKey: track.audioWavKey,
              durationMs: track.durationMs,
              isDialogue: track.isDialogue,
              speakerName: track.speakerName,
            });
          }
        } catch (error) {
          logger.warn("multi-track audio demuxing failed; continuing with primary audio", {
            mediaId: payload.mediaId,
            error: describeError(error),
          });
        }
      }
    }

    // --- proxy ------------------------------------------------------------
    if (facts.hasVideo) {
      context.report(40, "encoding the 540p proxy");
      const size = proxySize(facts.width, facts.height);
      const out = workspace.path("proxy540.mp4");
      const { toneMapped } = await encodeProxy(
        derive,
        { out, size, hdr: facts.hdr, hasAudio: facts.hasAudio, isVfr: facts.isVfr },
        (chunk) => {
          const progress = readEncodeProgress(chunk, facts.durationMs);
          // 40 → 85 is the encode's slice of the job.
          if (progress !== null) context.report(40 + progress * 0.45, "encoding the 540p proxy");
        },
      );
      if (facts.hdr && !toneMapped) {
        logger.warn("HDR source encoded without tone mapping", {
          mediaId: payload.mediaId,
          hint: "this ffmpeg has no zscale (libzimg); the proxy will look flat",
        });
      }
      keys.proxyKey = derivedKey(derivedPrefix, "proxy540.mp4");
      bytesWritten += await context.derived.putFile({
        key: keys.proxyKey,
        file: out,
        contentType: DERIVED_CONTENT_TYPES["proxy540.mp4"],
        tags: DERIVED_OBJECT_TAGS,
      });

      // --- thumbnails -----------------------------------------------------
      context.report(85, "grabbing thumbnails");
      const thumbs = thumbnailCount(facts.durationMs);
      for (let index = 0; index < thumbs; index += 1) {
        const at = thumbnailOffsetMs(facts.durationMs, index, thumbs);
        const file = workspace.path(`thumb-${String(index)}.jpg`);
        // A miss is not a failure: seeking into the tail of a variable-frame-rate
        // recording genuinely finds no frame, and nine images is still a filmstrip.
        if (!(await grabThumbnail(derive, file, at))) continue;
        const key = thumbKey(derivedPrefix, index);
        bytesWritten += await context.derived.putFile({
          key,
          file,
          contentType: DERIVED_CONTENT_TYPES.thumb,
          tags: DERIVED_OBJECT_TAGS,
        });
        keys.thumbKeys.push(key);
      }
    }

    context.report(98, "publishing");
    // Settled before the job reports, so the early write can never land after
    // the final one (it would change nothing if it did — it carries no status
    // and the same key — but an outcome with a request still in flight behind
    // it is harder to reason about than one without). It is bounded by the
    // callback client's durable budget and has almost always long finished.
    await announced;

    const result: ProxyResult = {
      mediaId: payload.mediaId,
      ...keys,
      durationMs: facts.durationMs,
      bytesWritten,
      builtAt: new Date().toISOString(),
    };

    return {
      result: result as unknown as Record<string, unknown>,
      mediaPatch: {
        // `ready` is this job's to write: it is the last thing the pipeline owes
        // the user, and the keys next to it are what "ready" means.
        status: "ready",
        ...(keys.proxyKey === null ? {} : { proxyKey: keys.proxyKey }),
        ...(keys.audio16kKey === null ? {} : { audio16kKey: keys.audio16kKey }),
        ...(keys.audio48kKey === null ? {} : { audio48kKey: keys.audio48kKey }),
        ...(keys.waveformKey === null ? {} : { waveformKey: keys.waveformKey }),
        thumbKeys: keys.thumbKeys,
        ...(audioTracks.length > 0 ? { audioTracks } : {}),
      },
      usage: { mediaSeconds: facts.durationMs / 1000, egressBytes: bytesWritten },
    };
  });
}

/**
 * `PATCH /internal/media/{id} { audio16kKey }` — the ASR audio exists, so the API
 * may start transcribing it while this job goes on to the video encode.
 *
 * - **Not awaited in line.** The encode must not wait on the API: while it is
 *   restarting, a durable callback keeps trying for up to two minutes, and the
 *   whole point is to take time off the critical path, not add it.
 * - **Never throws.** An early write that fails changes nothing the job owes:
 *   the final write-back carries the same key next to `status: "ready"`, and
 *   transcription then starts where it always did.
 * - **No status, nothing else.** The API accepts a partial patch without moving
 *   the row (`MediaPatchSchema`: every field optional); `ready` stays this job's
 *   last word, and `audio48kKey`/`waveformKey` still arrive with it.
 * - **Not for a job the API has already settled** (a stopped run): the runtime
 *   aborts `context.signal` when a heartbeat says so, and a stopped job's facts
 *   are not written, early or late.
 */
async function announceAudio(
  context: JobContext,
  mediaId: string,
  audio16kKey: string,
): Promise<void> {
  if (context.signal.aborted) return;
  try {
    await context.callbacks.patchMedia(mediaId, context.envelope.attemptId, { audio16kKey });
  } catch (error) {
    logger.warn("could not announce the ASR audio early; the final write-back carries it", {
      mediaId,
      error: describeError(error),
    });
  }
}

interface MediaFacts {
  readonly durationMs: number;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly width: number;
  readonly height: number;
  readonly hdr: boolean;
  readonly isVfr?: boolean;
  readonly audioStreams?: readonly ProbeAudioStream[];
}

/** The payload's hints when they are complete, a fresh ffprobe when they are not. */
async function resolveFacts(context: JobContext, payload: MediaProxyPayload): Promise<MediaFacts> {
  const complete =
    typeof payload.durationMs === "number" &&
    payload.durationMs > 0 &&
    typeof payload.hasVideo === "boolean" &&
    typeof payload.hasAudio === "boolean";

  if (complete) {
    const rawPayload = payload as unknown as Record<string, unknown>;
    let audioStreams: readonly ProbeAudioStream[] = (rawPayload["audioStreams"] as readonly ProbeAudioStream[] | undefined) ?? [];
    if (audioStreams.length === 0 && payload.hasAudio) {
      try {
        const source = await context.raw.presignGet(payload.key, context.settings.sourceUrlTtlSeconds);
        const output = await ffprobe({
          binary: context.settings.ffprobePath,
          source,
          timeoutMs: context.settings.ffmpegTimeoutMs,
          signal: context.signal,
        });
        audioStreams = readAudioStreams(output);
      } catch {
        // Ignored; fallback gracefully
      }
    }

    return {
      durationMs: payload.durationMs ?? 0,
      hasVideo: payload.hasVideo ?? false,
      hasAudio: payload.hasAudio ?? false,
      width: payload.width ?? 0,
      height: payload.height ?? 0,
      hdr: payload.hdr ?? false,
      isVfr: (rawPayload["isVfr"] as boolean | undefined) ?? false,
      audioStreams,
    };
  }

  const source = await context.raw.presignGet(payload.key, context.settings.sourceUrlTtlSeconds);
  const container = readProbe(
    await ffprobe({
      binary: context.settings.ffprobePath,
      source,
      timeoutMs: context.settings.ffmpegTimeoutMs,
      signal: context.signal,
    }),
  );
  return {
    durationMs: container.durationMs,
    hasVideo: container.video !== null,
    hasAudio: container.audio !== null,
    width: container.video?.width ?? 0,
    height: container.video?.height ?? 0,
    hdr: container.video?.hdr ?? false,
    isVfr: container.video?.isVfr ?? false,
    audioStreams: container.audioStreams,
  };
}

/**
 * Read `out_time_us` out of an `-progress pipe:2` block and turn it into 0–1.
 *
 * ffmpeg's own percentage does not exist; what it emits is a stream of
 * `key=value` lines every `-stats_period`, of which the elapsed output time is the
 * only one that means anything here. `N/A` appears while the first frame is still
 * being decoded.
 */
export function readEncodeProgress(chunk: string, durationMs: number): number | null {
  if (durationMs <= 0) return null;
  const match = /out_time_us=(\d+)/.exec(chunk);
  if (match === null) return null;
  const microseconds = Number(match[1]);
  if (!Number.isFinite(microseconds)) return null;
  return Math.max(0, Math.min(1, microseconds / 1000 / durationMs));
}

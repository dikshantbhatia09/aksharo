import { join } from "node:path";

import { FFMPEG_BASE_ARGS, inputArgs, run } from "../ffmpeg/run.js";
import { transientFailure, unreadableMedia } from "../errors.js";

import type { ProbeAudioStream } from "../ffmpeg/ffprobe.js";
import type { JobContext, ProcessorOutcome } from "../runtime.js";

/** Sample rate for isolated speaker demuxing (matches Whisper/diarization models). */
export const DEMUX_SAMPLE_RATE = 16_000;

export interface AudioTrackPlan {
  readonly streamIndex: number;
  readonly channelIndex: number;
  readonly label: string;
  readonly filename: string;
  readonly isDialogue: boolean;
  readonly speakerName: string;
  readonly useChannelPan?: boolean;
}

export interface DemuxedTrackResult {
  readonly streamIndex: number;
  readonly channelIndex: number;
  readonly label: string;
  readonly audioWavKey: string;
  readonly localPath: string;
  readonly durationMs: number;
  readonly isDialogue: boolean;
  readonly speakerName: string;
}

/**
 * Plan audio tracks to demux based on probed streams and channels.
 *
 * Supports:
 * - OBS multi-track recording: Track 1 = Mic, Track 2 = Discord/Guest, Track 3 = Desktop audio.
 * - Multi-channel interfaces (Rodecaster, Zoom, Focusrite): Stereo/polyphonic WAV with isolated speakers per channel.
 */
export function planAudioTracks(audioStreams: readonly ProbeAudioStream[]): AudioTrackPlan[] {
  if (audioStreams.length === 0) {
    return [];
  }

  // Case 1: Multiple audio streams in container (OBS, MKV, multi-track MP4)
  if (audioStreams.length > 1) {
    return audioStreams.map((stream, idx) => {
      const streamIndex = stream.index ?? idx;
      const title = stream.title?.trim();
      const defaultLabel = idx === 0 ? "Host Mic" : idx === 1 ? "Guest Audio" : `Track ${idx + 1}`;
      const label = title && title.length > 0 ? title : defaultLabel;
      const isNonDialogue = /(game|desktop|music|sfx|b-roll|broll|bgm|system|soundtrack|desktop audio)/i.test(label);
      const isDialogue = !isNonDialogue;
      const speakerName = !isDialogue
        ? ""
        : idx === 0
          ? "Host"
          : idx === 1
            ? "Guest"
            : `Speaker ${idx + 1}`;

      return {
        streamIndex,
        channelIndex: 0,
        label,
        filename: `track_${streamIndex}.wav`,
        isDialogue,
        speakerName,
        useChannelPan: false,
      };
    });
  }

  // Case 2: Single audio stream with multiple channels (stereo / 4-channel polyphonic WAV)
  const singleStream = audioStreams[0]!;
  const channels = singleStream.channels;
  const streamIndex = singleStream.index ?? 0;

  if (channels > 1) {
    const plans: AudioTrackPlan[] = [];
    for (let c = 0; c < channels; c++) {
      let label: string;
      let speakerName: string;
      if (channels === 2) {
        label = c === 0 ? "Channel 1 (Left / Host)" : "Channel 2 (Right / Guest)";
        speakerName = c === 0 ? "Host" : "Guest";
      } else {
        label = `Channel ${c + 1}`;
        speakerName = `Speaker ${c + 1}`;
      }

      plans.push({
        streamIndex,
        channelIndex: c,
        label,
        filename: `track_${streamIndex}_ch${c}.wav`,
        isDialogue: true,
        speakerName,
        useChannelPan: true,
      });
    }
    return plans;
  }

  // Case 3: Single mono stream
  return [
    {
      streamIndex,
      channelIndex: 0,
      label: singleStream.title?.trim() || "Track 1 (Dialogue)",
      filename: `track_${streamIndex}.wav`,
      isDialogue: true,
      speakerName: "Host",
      useChannelPan: false,
    },
  ];
}

/**
 * Build ffmpeg CLI arguments to demux planned tracks in a single fast pass.
 */
export function buildDemuxArgs(
  source: string,
  plan: readonly AudioTrackPlan[],
  outDir: string,
): string[] {
  if (plan.length === 0) {
    return [];
  }

  const hasChannelPan = plan.some((p) => p.useChannelPan);

  if (hasChannelPan) {
    // Single pass with filter_complex pan filters
    const filterClauses: string[] = [];
    const maps: string[] = [];

    plan.forEach((track, i) => {
      const outPath = join(outDir, track.filename);
      const outLabel = `out${i}`;
      filterClauses.push(
        `[0:a:${track.streamIndex}]pan=mono|c0=c${track.channelIndex}[${outLabel}]`,
      );
      maps.push("-map", `[${outLabel}]`, "-ar", String(DEMUX_SAMPLE_RATE), "-c:a", "pcm_s16le", outPath);
    });

    return [
      ...FFMPEG_BASE_ARGS,
      "-loglevel",
      "error",
      ...inputArgs(source),
      "-filter_complex",
      filterClauses.join(";"),
      ...maps,
    ];
  }

  // Stream mapping pass: -map 0:a:i -ac 1 -ar 16000 -c:a pcm_s16le
  const maps: string[] = [];
  plan.forEach((track) => {
    const outPath = join(outDir, track.filename);
    maps.push(
      "-map",
      `0:a:${track.streamIndex}`,
      "-ac",
      "1",
      "-ar",
      String(DEMUX_SAMPLE_RATE),
      "-c:a",
      "pcm_s16le",
      outPath,
    );
  });

  return [
    ...FFMPEG_BASE_ARGS,
    "-loglevel",
    "error",
    ...inputArgs(source),
    "-vn",
    "-sn",
    "-dn",
    ...maps,
  ];
}

/**
 * Execute multi-track audio demuxing.
 */
export async function demuxAudioTracks(options: {
  readonly binary: string;
  readonly source: string;
  readonly audioStreams: readonly ProbeAudioStream[];
  readonly durationMs: number;
  readonly outDir: string;
  readonly derivedPrefix: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<DemuxedTrackResult[]> {
  const plan = planAudioTracks(options.audioStreams);
  if (plan.length === 0) {
    return [];
  }

  const args = buildDemuxArgs(options.source, plan, options.outDir);
  const result = await run(options.binary, args, {
    timeoutMs: options.timeoutMs,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  if (result.code !== 0) {
    throw transientFailure("media/demux_failed", "FFmpeg failed to demux audio tracks.", {
      detail: result.stderr,
    });
  }

  const prefix = options.derivedPrefix.replace(/\/+$/, "");

  return plan.map((track) => ({
    streamIndex: track.streamIndex,
    channelIndex: track.channelIndex,
    label: track.label,
    audioWavKey: `${prefix}/tracks/${track.filename}`,
    localPath: join(options.outDir, track.filename),
    durationMs: options.durationMs,
    isDialogue: track.isDialogue,
    speakerName: track.speakerName,
  }));
}

/**
 * Processor implementation if dispatched as a standalone media job.
 */
export async function processDemuxAudio(context: JobContext): Promise<ProcessorOutcome> {
  const { settings, payload } = context;
  const source = await context.raw.presignGet(payload.key, settings.sourceUrlTtlSeconds);

  // In standalone mode, probe audio streams or read from payload
  return {
    result: { mediaId: payload.mediaId, status: "ready" },
  };
}


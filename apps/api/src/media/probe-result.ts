import { z } from "zod";

/**
 * What `media.probe` sends back in the completion body's `result` (CONTRACTS §3).
 *
 * This is the API's copy of a contract the worker owns the other half of
 * (`apps/worker-media/src/probe-result.ts`). The two are only ever correct
 * together, so `probe-result.test.ts` parses the worker's source and pins the
 * field list — the same drift guard the queue names and the retry policy have.
 * A mismatch here is not a compile error anywhere: it is a probe whose facts are
 * silently dropped on the floor.
 *
 * The schema is deliberately **tolerant of extra keys and strict about the ones
 * it names**. A worker rolled ahead of the API may report something new, and
 * refusing the whole completion because of a field the API does not use yet would
 * fail a job that did its work perfectly. What it must not do is accept a
 * `durationMs` that is a string, because that number decides a plan check.
 */

/** Rotation, in degrees, as it appears in a container's display matrix. */
export const ROTATIONS = [0, 90, 180, 270] as const;

/**
 * Colour transfer characteristics that mean HDR.
 *
 * `smpte2084` is PQ (HDR10, Dolby Vision's base layer); `arib-std-b67` is HLG.
 * Everything else — including `bt2020-10`, which is a wide *gamut* on an SDR
 * curve — is tone-mapped by nothing and flagged as nothing.
 */
export const HDR_TRANSFERS = ["smpte2084", "arib-std-b67"] as const;

export const ProbeVideoSchema = z.object({
  codec: z.string().min(1).max(64),
  /** Display dimensions: rotation is already applied, so 1080×1920 for a phone. */
  width: z.number().int().min(0).max(65_535),
  height: z.number().int().min(0).max(65_535),
  /** Average frame rate. `0` when the container declares none (a still image). */
  fps: z.number().min(0).max(1_000),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  pixelFormat: z.string().max(32).nullable().default(null),
  bitDepth: z.number().int().min(0).max(16).nullable().default(null),
  colourTransfer: z.string().max(64).nullable().default(null),
  colourPrimaries: z.string().max(64).nullable().default(null),
  /** PQ or HLG: the proxy is tone-mapped to BT.709 and the row is flagged. */
  hdr: z.boolean(),
});

export type ProbeVideo = z.infer<typeof ProbeVideoSchema>;

/** One stretch of near-silence, from ffmpeg's `silencedetect`. */
export const SilenceSpanSchema = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
});

export const ProbeAudioSchema = z.object({
  codec: z.string().min(1).max(64),
  channels: z.number().int().min(0).max(64),
  sampleRate: z.number().int().min(0).max(768_000),
  /**
   * EBU R128 integrated loudness in LUFS, and the two figures that go with it.
   *
   * Carried here rather than on `media_assets` because nothing reads them yet:
   * A09's routing wants to know whether a recording is quiet before it picks a
   * VAD threshold, and B-wave audio clean wants the loudness target. Until then
   * they live in `jobs.result`, which is the right place for a measurement no
   * column has been designed for.
   */
  loudnessLufs: z.number().nullable().default(null),
  loudnessRangeLu: z.number().min(0).nullable().default(null),
  truePeakDbfs: z.number().nullable().default(null),
  /** Fraction of the timeline below the silence threshold, 0–1. */
  silenceRatio: z.number().min(0).max(1).nullable().default(null),
  /** The longest spans, newest analysis first. Capped by the worker. */
  silences: z.array(SilenceSpanSchema).max(500).default([]),
});

export type ProbeAudio = z.infer<typeof ProbeAudioSchema>;

export const ProbeResultSchema = z.looseObject({
  mediaId: z.string().min(1).max(64),
  /** `ffprobe`'s `format_name`, e.g. `mov,mp4,m4a,3gp,3g2,mj2`. */
  container: z.string().min(1).max(255),
  /** The container's real media type, which overrides the uploader's claim (T7). */
  mime: z.string().min(1).max(255).nullable().default(null),
  durationMs: z.number().int().min(0),
  sizeBytes: z.number().int().min(0).nullable().default(null),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  video: ProbeVideoSchema.nullable().default(null),
  audio: ProbeAudioSchema.nullable().default(null),
  /** ISO-8601. */
  probedAt: z.string().min(1).max(64),
  /** `ffprobe version 9.0`, so a regression can be tied to a toolchain roll. */
  toolVersion: z.string().max(255).nullable().default(null),
});

export type ProbeResult = z.infer<typeof ProbeResultSchema>;

/** Every field the API reads off a probe result; the drift guard pins this list. */
export const PROBE_RESULT_FIELDS = [
  "mediaId",
  "container",
  "mime",
  "durationMs",
  "sizeBytes",
  "hasVideo",
  "hasAudio",
  "video",
  "audio",
  "probedAt",
  "toolVersion",
] as const;

/**
 * The payload the probe's completion hands to `media.proxy`.
 *
 * Everything the proxy would otherwise have to re-probe for. It is still only a
 * hint: `processProxy` probes for itself when a field is missing, because a job
 * replayed from the dead-letter queue months later must not depend on a payload
 * written by a worker version that no longer exists.
 */
export interface ProxyJobPayload extends Record<string, unknown> {
  readonly mediaId: string;
  readonly projectId: string | null;
  readonly bucket: string;
  readonly key: string;
  readonly derivedBucket: string;
  readonly derivedPrefix: string;
  readonly durationMs: number;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly width: number | null;
  readonly height: number | null;
  readonly hdr: boolean;
}

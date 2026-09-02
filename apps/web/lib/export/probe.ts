/**
 * Capability probe (brief §1).
 *
 * Walks the `VideoEncoder.isConfigSupported` H.264 codec ladder high to low
 * (`avc1.640034` → `avc1.4d0034` → `avc1.42e01f`), checks a VP9 fallback for
 * WebM, checks `AudioEncoder` presence and AAC support, checks
 * `showSaveFilePicker` availability, samples decode+encode throughput for
 * ~2 seconds against the proxy, and reads device-memory hints. Every WebCodecs
 * call is optional-chained: a browser without the API (Safari — see
 * `README.md`'s support matrix) answers `false`/`null` everywhere rather than
 * throwing, so this function is safe to call unconditionally.
 */

import {
  BROWSER_DURATION_CAPS_MS,
  H264_CODEC_LADDER,
  VP9_FALLBACK_CODEC,
  type AudioCodecSupport,
  type CodecSupport,
  type ExportCapabilitiesRequest,
  type ExportCapabilityProbe,
  type H264Codec,
  type ThroughputSample,
} from "./types";

/** Minimal shape of the global WebCodecs surface this module touches, for test doubles. */
export interface WebCodecsGlobals {
  readonly VideoEncoder?: {
    isConfigSupported: (config: unknown) => Promise<{ supported: boolean; config?: unknown }>;
  };
  readonly VideoDecoder?: {
    isConfigSupported: (config: unknown) => Promise<{ supported: boolean; config?: unknown }>;
  };
  readonly AudioEncoder?: {
    isConfigSupported: (config: unknown) => Promise<{ supported: boolean; config?: unknown }>;
  };
}

function getGlobals(): WebCodecsGlobals {
  return globalThis as unknown as WebCodecsGlobals;
}

async function probeVideoCodec(
  codec: string,
  width: number,
  height: number,
): Promise<CodecSupport> {
  const g = getGlobals();
  if (g.VideoEncoder?.isConfigSupported === undefined) {
    return { codec, supported: false, hardwareAccelerated: "unknown" };
  }
  try {
    const hw = await g.VideoEncoder.isConfigSupported({
      codec,
      width,
      height,
      hardwareAcceleration: "prefer-hardware",
    });
    if (hw.supported) return { codec, supported: true, hardwareAccelerated: true };
    const sw = await g.VideoEncoder.isConfigSupported({
      codec,
      width,
      height,
      hardwareAcceleration: "prefer-software",
    });
    return {
      codec,
      supported: sw.supported,
      hardwareAccelerated: sw.supported ? false : "unknown",
    };
  } catch {
    return { codec, supported: false, hardwareAccelerated: "unknown" };
  }
}

async function probeH264Ladder(width: number, height: number): Promise<CodecSupport[]> {
  const results: CodecSupport[] = [];
  for (const codec of H264_CODEC_LADDER) {
    results.push(await probeVideoCodec(codec, width, height));
  }
  return results;
}

async function probeAudio(): Promise<AudioCodecSupport> {
  const g = getGlobals();
  if (g.AudioEncoder?.isConfigSupported === undefined) return { aac: false, opus: false };
  const check = async (
    codec: string,
    sampleRate: number,
    numberOfChannels: number,
  ): Promise<boolean> => {
    try {
      const result = await g.AudioEncoder?.isConfigSupported({
        codec,
        sampleRate,
        numberOfChannels,
        bitrate: 192_000,
      });
      return result?.supported ?? false;
    } catch {
      return false;
    }
  };
  const [aac, opus] = await Promise.all([check("mp4a.40.2", 48_000, 2), check("opus", 48_000, 2)]);
  return { aac, opus };
}

function fileSystemAccessAvailable(): boolean {
  return typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";
}

function deviceMemoryGiB(): number | undefined {
  const nav = (globalThis as { navigator?: { deviceMemory?: number } }).navigator;
  return nav?.deviceMemory;
}

function isMobileUserAgent(userAgent: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
}

function isDesktopChromiumUserAgent(userAgent: string): boolean {
  return /Chrome|Chromium|Edg\//.test(userAgent) && !isMobileUserAgent(userAgent);
}

/**
 * A ~2-second decode+encode throughput sample against a supplied proxy video
 * element (or a synthetic canvas source in tests). Left as an injectable
 * function rather than baked in here so the probe stays a pure orchestrator;
 * `runThroughputSample` in `engine.ts` supplies the real implementation in the
 * browser, and tests inject a fixed sample.
 */
export type ThroughputSampler = (budgetMs: number) => Promise<ThroughputSample | null>;

export interface ProbeOptions {
  /** Output dimensions the ladder is probed against; defaults to 1080×1920 (Reels). */
  readonly width?: number;
  readonly height?: number;
  readonly userAgent?: string;
  readonly sampleThroughput?: ThroughputSampler;
  /** Mediabunny's own pre-flight over the actual source, when one is available. */
  readonly discardedTracks?: readonly string[];
}

export async function probeExportCapabilities(
  options: ProbeOptions = {},
): Promise<ExportCapabilityProbe> {
  const width = options.width ?? 1080;
  const height = options.height ?? 1920;
  const userAgent =
    options.userAgent ??
    (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ??
    "";

  const g = getGlobals();
  const webCodecs = g.VideoEncoder !== undefined && g.VideoDecoder !== undefined;

  const videoCodecs = webCodecs ? await probeH264Ladder(width, height) : [];
  const bestH264 = (videoCodecs.find((c) => c.supported)?.codec as H264Codec | undefined) ?? null;
  const vp9 = webCodecs ? await probeVideoCodec(VP9_FALLBACK_CODEC, width, height) : null;
  const audio = webCodecs ? await probeAudio() : { aac: false, opus: false };
  const throughput = options.sampleThroughput ? await options.sampleThroughput(2_000) : null;

  return {
    videoCodecs,
    bestH264,
    vp9,
    audio,
    audioEncoderAvailable: g.AudioEncoder !== undefined,
    fileSystemAccess: fileSystemAccessAvailable(),
    offscreenCanvas:
      typeof (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas === "function",
    webCodecs,
    deviceMemoryGiB: deviceMemoryGiB(),
    isMobile: isMobileUserAgent(userAgent),
    isDesktopChromium: isDesktopChromiumUserAgent(userAgent),
    throughput,
    discardedTracks: options.discardedTracks ?? [],
  };
}

/** Shapes the probe result into `POST /exports`'s `capabilities` field. */
export function toCapabilitiesRequest(probe: ExportCapabilityProbe): ExportCapabilitiesRequest {
  return {
    codecs: probe.videoCodecs.filter((c) => c.supported).map((c) => c.codec),
    audioEncoder: probe.audioEncoderAvailable,
    discardedTracks: [...probe.discardedTracks],
    fileSink: probe.fileSystemAccess,
    isDesktopChromium: probe.isDesktopChromium,
    isMobile: probe.isMobile,
    ...(probe.throughput === null
      ? {}
      : { throughputMbps: Math.round(probe.throughput.realtimeMultiplier * 100) / 100 }),
  };
}

/**
 * Whether this browser can attempt the browser export path at all — the
 * client-side half of A21's decision engine (`apps/api/src/exports/decision.ts`
 * makes the authoritative call; this is what the dialog uses to decide whether
 * to even offer "auto" a chance, and to explain a WebKit fallback before a
 * round trip to the API).
 */
export function isBrowserExportEligible(probe: ExportCapabilityProbe): boolean {
  if (!probe.webCodecs) return false;
  if (probe.bestH264 === null) return false;
  if (!probe.offscreenCanvas) return false;
  // Audio is not strictly required (a caption-only clip can export silent),
  // but no AAC and no polyfill means the audio decision tree has nowhere left
  // to go besides cloud — the dialog checks this via `decideAudioStrategy`.
  return true;
}

/** The technical duration cap for a given output height, per D34. */
export function durationCapMsFor(height: number): number {
  return height > 1080 ? BROWSER_DURATION_CAPS_MS.uhd4kMax : BROWSER_DURATION_CAPS_MS.hd1080Max;
}

/**
 * Shared types for the browser export pipeline (A19).
 *
 * `apps/web/lib/export/**` is the browser-native export engine: capability
 * probe, manifest handling, the decode → composite → cut/audio → encode → mux
 * pipeline (WebCodecs + Mediabunny + CanvasKit), and subtitle generation.
 * `apps/web/components/editor/export/**` is the dialog that drives it.
 *
 * See `README.md` in this directory for the pipeline design and the
 * deviations from the brief this work package had to report.
 */

import type { RenderManifest } from "@montaj/render-manifest";

/** One rung of the H.264 codec ladder the probe walks, high to low. */
export const H264_CODEC_LADDER = ["avc1.640034", "avc1.4d0034", "avc1.42e01f"] as const;
export type H264Codec = (typeof H264_CODEC_LADDER)[number];

/** VP9 fallback offered only for a WebM container. */
export const VP9_FALLBACK_CODEC = "vp09.00.10.08" as const;

export interface CodecSupport {
  readonly codec: string;
  readonly supported: boolean;
  readonly hardwareAccelerated: boolean | "unknown";
}

export interface AudioCodecSupport {
  readonly aac: boolean;
  readonly opus: boolean;
}

/** The result of the 2-second decode+encode throughput sample. */
export interface ThroughputSample {
  /** Frames decoded and re-encoded during the sample window. */
  readonly frames: number;
  /** Wall-clock milliseconds the sample took (target ~2000). */
  readonly elapsedMs: number;
  /** `frames / (elapsedMs/1000)` against the sample's own fps, i.e. a realtime multiplier. */
  readonly realtimeMultiplier: number;
}

/**
 * Everything the export dialog and `POST /projects/{id}/exports` need to know
 * about this browser, gathered once and cached for the session.
 */
export interface ExportCapabilityProbe {
  readonly videoCodecs: readonly CodecSupport[];
  /** The best H.264 level this browser can encode, or `null` if none. */
  readonly bestH264: H264Codec | null;
  readonly vp9: CodecSupport | null;
  readonly audio: AudioCodecSupport;
  readonly audioEncoderAvailable: boolean;
  readonly fileSystemAccess: boolean;
  readonly offscreenCanvas: boolean;
  readonly webCodecs: boolean;
  /** `navigator.deviceMemory`, in GiB; `undefined` where the browser hides it (Safari, Firefox). */
  readonly deviceMemoryGiB: number | undefined;
  readonly isMobile: boolean;
  readonly isDesktopChromium: boolean;
  readonly throughput: ThroughputSample | null;
  /** Track ids Mediabunny's own pre-flight says it cannot place in the target container. */
  readonly discardedTracks: readonly string[];
}

/** The subset of the probe `POST /exports` reads, per `exports.dto.ts`'s `CapabilitiesRequest`. */
export interface ExportCapabilitiesRequest {
  readonly codecs?: string[];
  readonly audioEncoder?: boolean;
  readonly discardedTracks?: string[];
  readonly fileSink?: boolean;
  readonly isDesktopChromium?: boolean;
  readonly isMobile?: boolean;
  readonly throughputMbps?: number;
}

export type AudioStrategyDecision =
  | { readonly kind: "copy" }
  | { readonly kind: "encode"; readonly codec: "aac" }
  | { readonly kind: "polyfill"; readonly codec: "aac" }
  | { readonly kind: "none" }
  | { readonly kind: "cloud-required"; readonly reason: string };

export interface EngineProgress {
  readonly phase: "decoding" | "compositing" | "encoding" | "muxing" | "done";
  /** 0..1 */
  readonly ratio: number;
  readonly framesDone: number;
  readonly framesTotal: number;
  readonly etaMs: number | null;
}

export interface EngineResult {
  readonly sizeBytes: number;
  readonly durationMs: number;
  /** hex sha256 of the output bytes, sent to `POST /exports/manifests/{id}/complete`. */
  readonly checksum: string;
  /** Present when the memory sink was used (no File System Access). */
  readonly blob?: Blob;
  readonly usedFileSystemAccess: boolean;
  /** Wall-clock encode time / output duration; ≥1 means at-or-faster-than realtime (A19b target: ≥1 at 1080p on chromium). */
  readonly realtimeMultiplier: number;
}

export interface EngineOptions {
  readonly manifest: RenderManifest;
  readonly sourceUrl: string;
  /** Signed URL to the replacement (cleaned) audio track, required when `audio.strategy === "replace"`. */
  readonly cleanAudioUrl?: string;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: EngineProgress) => void;
}

export class ExportCancelledError extends Error {
  constructor() {
    super("export cancelled");
    this.name = "ExportCancelledError";
  }
}

/** Defensive-loop numbers (brief §3): in-flight VideoFrame caps and decoder look-ahead. */
export const DEFENSIVE_LIMITS = {
  /** Frames allowed in flight (decoded, not yet encoded) at 4K. */
  inFlight4k: 4,
  /** Frames allowed in flight at 1080p and below. */
  inFlight1080p: 8,
  /** Chunks queued ahead of the decoder before backpressure kicks in. */
  decodeQueueAhead: 16,
  /** `VideoEncoder.encodeQueueSize` ceiling before backpressure. */
  encodeQueueSize: 16,
} as const;

/** Technical hard caps the brief fixes for the browser path (D34). */
export const BROWSER_DURATION_CAPS_MS = {
  hd1080Max: 20 * 60_000,
  uhd4kMax: 10 * 60_000,
} as const;

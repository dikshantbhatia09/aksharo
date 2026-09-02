import { afterEach, describe, expect, it, vi } from "vitest";

import {
  durationCapMsFor,
  isBrowserExportEligible,
  probeExportCapabilities,
  toCapabilitiesRequest,
} from "./probe";
import { H264_CODEC_LADDER } from "./types";

const ORIGINAL_VIDEO_ENCODER = (globalThis as { VideoEncoder?: unknown }).VideoEncoder;
const ORIGINAL_VIDEO_DECODER = (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
const ORIGINAL_AUDIO_ENCODER = (globalThis as { AudioEncoder?: unknown }).AudioEncoder;

afterEach(() => {
  (globalThis as { VideoEncoder?: unknown }).VideoEncoder = ORIGINAL_VIDEO_ENCODER;
  (globalThis as { VideoDecoder?: unknown }).VideoDecoder = ORIGINAL_VIDEO_DECODER;
  (globalThis as { AudioEncoder?: unknown }).AudioEncoder = ORIGINAL_AUDIO_ENCODER;
  vi.unstubAllGlobals();
});

function stubWebCodecs(options: {
  supportedH264: readonly string[];
  aac: boolean;
  hasAudioEncoder?: boolean;
}): void {
  vi.stubGlobal("VideoEncoder", {
    isConfigSupported: async (config: { codec: string }) => ({
      supported: options.supportedH264.includes(config.codec),
    }),
  });
  vi.stubGlobal("VideoDecoder", {
    isConfigSupported: async () => ({ supported: true }),
  });
  if (options.hasAudioEncoder !== false) {
    vi.stubGlobal("AudioEncoder", {
      isConfigSupported: async (config: { codec: string }) => ({
        supported: config.codec === "mp4a.40.2" ? options.aac : false,
      }),
    });
  }
}

describe("probeExportCapabilities", () => {
  it("reports no WebCodecs support when the globals are missing (Safari)", async () => {
    vi.stubGlobal("VideoEncoder", undefined);
    vi.stubGlobal("VideoDecoder", undefined);
    vi.stubGlobal("AudioEncoder", undefined);
    const probe = await probeExportCapabilities();
    expect(probe.webCodecs).toBe(false);
    expect(probe.bestH264).toBeNull();
    expect(isBrowserExportEligible(probe)).toBe(false);
  });

  it("walks the H.264 ladder high to low and picks the best supported codec", async () => {
    stubWebCodecs({ supportedH264: [H264_CODEC_LADDER[1], H264_CODEC_LADDER[2]], aac: true });
    const probe = await probeExportCapabilities();
    expect(probe.bestH264).toBe(H264_CODEC_LADDER[1]);
    expect(probe.videoCodecs.map((c) => c.supported)).toEqual([false, true, true]);
  });

  it("reports AAC support from the AudioEncoder probe", async () => {
    stubWebCodecs({ supportedH264: [H264_CODEC_LADDER[0]], aac: true });
    const probe = await probeExportCapabilities();
    expect(probe.audio.aac).toBe(true);
    expect(probe.audioEncoderAvailable).toBe(true);
  });

  it("is eligible once WebCodecs, an H.264 codec and OffscreenCanvas are present", async () => {
    stubWebCodecs({ supportedH264: [H264_CODEC_LADDER[0]], aac: true });
    vi.stubGlobal("OffscreenCanvas", class {});
    const probe = await probeExportCapabilities();
    expect(isBrowserExportEligible(probe)).toBe(true);
  });

  it("carries a throughput sample through when a sampler is supplied", async () => {
    stubWebCodecs({ supportedH264: [H264_CODEC_LADDER[0]], aac: true });
    const probe = await probeExportCapabilities({
      sampleThroughput: async () => ({ frames: 60, elapsedMs: 2000, realtimeMultiplier: 1.0 }),
    });
    expect(probe.throughput?.realtimeMultiplier).toBe(1.0);
  });
});

describe("toCapabilitiesRequest", () => {
  it("shapes the probe into POST /exports's capabilities field", async () => {
    stubWebCodecs({ supportedH264: [H264_CODEC_LADDER[0]], aac: true });
    const probe = await probeExportCapabilities();
    const request = toCapabilitiesRequest(probe);
    expect(request.codecs).toEqual([H264_CODEC_LADDER[0]]);
    expect(request.audioEncoder).toBe(true);
  });
});

describe("durationCapMsFor", () => {
  it("uses the 1080p cap at and below 1080 height", () => {
    expect(durationCapMsFor(1080)).toBe(20 * 60_000);
  });
  it("uses the tighter 4K cap above 1080 height", () => {
    expect(durationCapMsFor(2160)).toBe(10 * 60_000);
  });
});

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

  it("A19c: reports hardwareEncoder true when prefer-hardware is supported", async () => {
    stubWebCodecs({ supportedH264: [H264_CODEC_LADDER[0]], aac: true });
    const probe = await probeExportCapabilities();
    expect(probe.hardwareEncoder).toBe(true);
  });

  it("A19c: reports hardwareEncoder false when prefer-hardware answers unsupported but prefer-software works (software-only encoder)", async () => {
    vi.stubGlobal("VideoEncoder", {
      isConfigSupported: async (config: { hardwareAcceleration?: string }) => ({
        supported: config.hardwareAcceleration !== "prefer-hardware",
      }),
    });
    vi.stubGlobal("VideoDecoder", { isConfigSupported: async () => ({ supported: true }) });
    vi.stubGlobal("AudioEncoder", {
      isConfigSupported: async () => ({ supported: true }),
    });
    const probe = await probeExportCapabilities();
    expect(probe.bestH264).not.toBeNull();
    expect(probe.hardwareEncoder).toBe(false);
  });

  it("A19c: reports hardwareEncoder false, not a throw, when isConfigSupported rejects for prefer-hardware (this sandbox's own behaviour, per README.md)", async () => {
    // Unlike the ladder's own `probeVideoCodec` (which shares one try/catch
    // across both the hardware and software calls, so a hardware-call throw
    // also swallows the ladder's software fallback for that rung), the
    // dedicated hardware probe only ever asks the hardware question — a
    // throw there is reported as `false`, exactly like an explicit
    // `supported: false` answer, with no effect on `bestH264` as long as
    // *some* rung of the ladder answers `prefer-software` successfully.
    vi.stubGlobal("VideoEncoder", {
      isConfigSupported: async (config: { codec: string; hardwareAcceleration?: string }) => {
        if (config.hardwareAcceleration === "prefer-hardware" && config.codec === H264_CODEC_LADDER[0]) {
          throw new Error("this specific encoder configuration is not supported in this environment");
        }
        return { supported: config.hardwareAcceleration !== "prefer-hardware" };
      },
    });
    vi.stubGlobal("VideoDecoder", { isConfigSupported: async () => ({ supported: true }) });
    vi.stubGlobal("AudioEncoder", {
      isConfigSupported: async () => ({ supported: true }),
    });
    const probe = await probeExportCapabilities();
    expect(probe.bestH264).not.toBeNull();
    expect(probe.hardwareEncoder).toBe(false);
  });

  it("A19c: reports hardwareEncoder null when there is no WebCodecs at all", async () => {
    vi.stubGlobal("VideoEncoder", undefined);
    vi.stubGlobal("VideoDecoder", undefined);
    vi.stubGlobal("AudioEncoder", undefined);
    const probe = await probeExportCapabilities();
    expect(probe.hardwareEncoder).toBeNull();
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

  it("A19c: carries hardwareEncoder through, omitting it when null", async () => {
    stubWebCodecs({ supportedH264: [H264_CODEC_LADDER[0]], aac: true });
    const probe = await probeExportCapabilities();
    expect(toCapabilitiesRequest(probe).hardwareEncoder).toBe(true);

    vi.stubGlobal("VideoEncoder", undefined);
    vi.stubGlobal("VideoDecoder", undefined);
    vi.stubGlobal("AudioEncoder", undefined);
    const ineligibleProbe = await probeExportCapabilities();
    expect(toCapabilitiesRequest(ineligibleProbe).hardwareEncoder).toBeUndefined();
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

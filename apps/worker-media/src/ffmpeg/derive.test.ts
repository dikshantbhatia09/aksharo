import { describe, expect, it } from "vitest";

import {
  ASR_SAMPLE_RATE,
  MASTER_SAMPLE_RATE,
  PROXY_CRF,
  PROXY_SHORT_SIDE,
  THUMBNAIL_COUNT,
  THUMBNAIL_WIDTH,
  audioArgs,
  proxyArgs,
  proxyFilter,
  proxySize,
  thumbnailArgs,
  thumbnailOffsetMs,
  toneMapFilter,
} from "./derive.js";

/** The argument after `flag`, so a test reads like the command line does. */
function valueOf(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

describe("proxySize", () => {
  it("puts the SHORT side at 540, landscape and portrait alike", () => {
    // This is a vertical-video product: scaling a 1080×1920 phone clip to 540
    // *height* would make it 304 px wide, which nobody can cut on.
    expect(proxySize(1920, 1080)).toEqual({ width: 960, height: 540 });
    expect(proxySize(1080, 1920)).toEqual({ width: 540, height: 960 });
    expect(proxySize(1080, 1080)).toEqual({ width: 540, height: 540 });
  });

  it("scales 4K down and leaves anything already small alone", () => {
    expect(proxySize(3840, 2160)).toEqual({ width: 960, height: 540 });
    // Never upscaled: a 480p source stays 480p rather than becoming a bigger,
    // blurrier file than the original.
    expect(proxySize(640, 480)).toEqual({ width: 640, height: 480 });
  });

  it("always produces even dimensions, because 4:2:0 cannot encode odd ones", () => {
    for (const [width, height] of [
      [1999, 1001],
      [1441, 1081],
      [721, 407],
      [3, 5],
    ]) {
      const size = proxySize(width ?? 0, height ?? 0);
      expect(size.width % 2, `${String(width)}x${String(height)}`).toBe(0);
      expect(size.height % 2, `${String(width)}x${String(height)}`).toBe(0);
      expect(size.width).toBeGreaterThanOrEqual(2);
      expect(size.height).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps the aspect ratio within a pixel of the source", () => {
    const size = proxySize(1920, 1080);
    expect(size.width / size.height).toBeCloseTo(1920 / 1080, 2);
  });

  it("answers zeroes for a stream with no dimensions", () => {
    expect(proxySize(0, 0)).toEqual({ width: 0, height: 0 });
  });

  it("never exceeds the target on the short side", () => {
    for (const [width, height] of [
      [4096, 2160],
      [720, 1280],
      [2160, 3840],
    ]) {
      const size = proxySize(width ?? 0, height ?? 0);
      expect(Math.min(size.width, size.height)).toBeLessThanOrEqual(PROXY_SHORT_SIDE);
    }
  });
});

describe("audioArgs", () => {
  it("asks for exactly the mono PCM the ASR and mastering paths want", () => {
    const asr = audioArgs(ASR_SAMPLE_RATE, "in.mp4", "out.wav");
    expect(valueOf(asr, "-ar")).toBe("16000");
    expect(valueOf(asr, "-ac")).toBe("1");
    expect(valueOf(asr, "-c:a")).toBe("pcm_s16le");
    // The FIRST audio stream, not whichever ffmpeg thinks is best: a commentary
    // track would otherwise become the transcript.
    expect(valueOf(asr, "-map")).toBe("0:a:0");
    expect(asr).toContain("-vn");

    expect(valueOf(audioArgs(MASTER_SAMPLE_RATE, "in.mp4", "out.wav"), "-ar")).toBe("48000");
  });

  it("adds HTTP reconnect options only for a URL source", () => {
    expect(audioArgs(ASR_SAMPLE_RATE, "https://example.test/x", "o.wav")).toContain("-reconnect");
    expect(audioArgs(ASR_SAMPLE_RATE, "/tmp/x.mp4", "o.wav")).not.toContain("-reconnect");
  });
});

describe("proxyFilter", () => {
  it("scales and packs to yuv420p for an SDR source", () => {
    const filter = proxyFilter({ width: 960, height: 540 }, false);
    expect(filter).toBe("scale=960:540:flags=bicubic,format=yuv420p");
    expect(filter).not.toContain("tonemap");
  });

  it("prepends the tone-map chain for an HDR source", () => {
    const filter = proxyFilter({ width: 540, height: 960 }, true);
    expect(filter.startsWith(toneMapFilter())).toBe(true);
    expect(filter).toContain("tonemap=tonemap=hable");
    // Linearise before mapping, land on BT.709 after: without both the picture
    // comes out grey.
    expect(filter).toContain("zscale=transfer=linear");
    expect(filter).toContain("zscale=transfer=bt709:matrix=bt709:range=tv");
    expect(filter.endsWith("format=yuv420p")).toBe(true);
  });
});

describe("proxyArgs", () => {
  const base = { source: "in.mp4", out: "out.mp4", size: { width: 960, height: 540 } };

  it("encodes the 540p H.264 the brief specifies, faststart included", () => {
    const args = proxyArgs({ ...base, hdr: false, hasAudio: true });
    expect(valueOf(args, "-c:v")).toBe("libx264");
    expect(valueOf(args, "-profile:v")).toBe("main");
    expect(valueOf(args, "-crf")).toBe(String(PROXY_CRF));
    expect(valueOf(args, "-pix_fmt")).toBe("yuv420p");
    expect(valueOf(args, "-c:a")).toBe("aac");
    expect(valueOf(args, "-b:a")).toBe("96k");
    // The moov atom first, or a browser must fetch the end of the file to start.
    expect(valueOf(args, "-movflags")).toBe("+faststart");
  });

  it("drops the audio mapping entirely for a silent source", () => {
    const args = proxyArgs({ ...base, hdr: false, hasAudio: false });
    expect(args).toContain("-an");
    expect(args).not.toContain("aac");
  });

  it("asks ffmpeg for machine-readable progress, so the heartbeat is not a guess", () => {
    expect(valueOf(proxyArgs({ ...base, hdr: false, hasAudio: true }), "-progress")).toBe("pipe:2");
  });
});

describe("thumbnailOffsetMs", () => {
  it("takes the midpoint of each slice, not its edge", () => {
    // Frame zero is a slate more often than not, and the last frame is a fade.
    expect(thumbnailOffsetMs(10_000, 0, 10)).toBe(500);
    expect(thumbnailOffsetMs(10_000, 9, 10)).toBe(9_500);
  });

  it("stays strictly inside the clip for every index", () => {
    for (let index = 0; index < THUMBNAIL_COUNT; index += 1) {
      const at = thumbnailOffsetMs(3_000, index, THUMBNAIL_COUNT);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(3_000);
    }
  });

  it("answers zero for a duration it does not know", () => {
    expect(thumbnailOffsetMs(0, 3, 10)).toBe(0);
  });
});

describe("thumbnailArgs", () => {
  it("seeks on the INPUT, which is what makes ten thumbnails cheap", () => {
    const args = thumbnailArgs({ source: "in.mp4", out: "t.jpg", atMs: 4_500 });
    // `-ss` must come before `-i`: after it, ffmpeg decodes from the start.
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(valueOf(args, "-ss")).toBe("4.500");
    expect(valueOf(args, "-frames:v")).toBe("1");
    expect(valueOf(args, "-vf")).toContain(`scale=${String(THUMBNAIL_WIDTH)}:-2`);
  });
});

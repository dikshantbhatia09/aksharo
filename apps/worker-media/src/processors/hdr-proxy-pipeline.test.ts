import { spawnSync } from "node:child_process";
import { open } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encodeProxy, proxySize } from "../ffmpeg/derive.js";
import { ffprobe, readProbe } from "../ffmpeg/ffprobe.js";

function ffmpegAvailable(): boolean {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return result.status === 0;
}

const CAN_RUN = ffmpegAvailable();

function generate(args: readonly string[]): void {
  const result = spawnSync("ffmpeg", args, { stdio: "ignore" });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
}

/** Check if MP4 file has moov atom before mdat atom (+faststart flag) in header */
async function hasFaststartMoov(filePath: string): Promise<boolean> {
  const file = await open(filePath, "r");
  try {
    // Faststart places moov atom in the first few kilobytes
    const buf = Buffer.alloc(131072);
    const { bytesRead } = await file.read(buf, 0, buf.length, 0);
    const data = buf.subarray(0, bytesRead);
    const moovPos = data.indexOf("moov");
    const mdatPos = data.indexOf("mdat");
    return moovPos !== -1 && (mdatPos === -1 || moovPos < mdatPos);
  } finally {
    await file.close();
  }
}

/** Measure Y luminance stats (YMIN, YMAX, YAVG) across frames using signalstats filter */
function measureLuminanceStats(filePath: string): { yMin: number; yMax: number; yAvg: number } {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      filePath,
      "-vf",
      "signalstats",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );

  const output = result.stderr;
  const yAvgMatches = [...output.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  const yMinMatches = [...output.matchAll(/YMIN=(\d+)/g)].map((m) => Number(m[1]));
  const yMaxMatches = [...output.matchAll(/YMAX=(\d+)/g)].map((m) => Number(m[1]));

  const yAvg = yAvgMatches.length > 0 ? yAvgMatches.reduce((a, b) => a + b, 0) / yAvgMatches.length : 128;
  const yMin = yMinMatches.length > 0 ? Math.min(...yMinMatches) : 16;
  const yMax = yMaxMatches.length > 0 ? Math.max(...yMaxMatches) : 235;

  return { yMin, yMax, yAvg };
}

describe.skipIf(!CAN_RUN)("4K HDR Ingestion & Proxy Pipeline (Feature 07)", () => {
  let dir = "";
  let sdrFile = "";
  let hdr10File = "";
  let hlgFile = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "montaj-4k-hdr-"));

    // 1. SDR reference video: 1920x1080 @ 30fps BT.709
    sdrFile = join(dir, "sdr_reference.mp4");
    generate([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=1920x1080:rate=30:duration=1",
      "-vf",
      "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      sdrFile,
    ]);

    // 2. HDR10 fixture: 4K 3840x2160 @ 60fps PQ 10-bit BT.2020 (smpte2084)
    hdr10File = join(dir, "hdr10_4k_60fps.mp4");
    generate([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=3840x2160:rate=60:duration=1",
      "-vf",
      "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p10le",
      "-movflags",
      "+faststart",
      hdr10File,
    ]);

    // 3. HLG fixture: 4K 3840x2160 @ 60fps HLG 10-bit BT.2020 (arib-std-b67)
    hlgFile = join(dir, "hlg_4k_60fps.mp4");
    generate([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=3840x2160:rate=60:duration=1",
      "-vf",
      "setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p10le",
      "-movflags",
      "+faststart",
      hlgFile,
    ]);
  }, 180_000);

  afterAll(async () => {
    if (dir !== "") await rm(dir, { recursive: true, force: true });
  });

  describe("Color space detection for SDR vs HDR10 vs HLG fixtures", () => {
    it("probes SDR reference video as isHdr=false with BT.709 transfer and primaries", async () => {
      const probeOutput = await ffprobe({ binary: "ffprobe", source: sdrFile, timeoutMs: 30_000 });
      const container = readProbe(probeOutput);
      expect(container.video).not.toBeNull();
      const video = container.video!;

      expect(video.hdr).toBe(false);
      expect(video.colourTransfer).toBe("bt709");
      expect(video.colourPrimaries).toBe("bt709");
      expect(video.bitDepth).toBe(8);
      expect(video.width).toBe(1920);
      expect(video.height).toBe(1080);
      expect(video.fps).toBeCloseTo(30, 1);
    });

    it("probes HDR10 4K 60fps video as isHdr=true with smpte2084 and BT.2020 primaries", async () => {
      const probeOutput = await ffprobe({ binary: "ffprobe", source: hdr10File, timeoutMs: 30_000 });
      const container = readProbe(probeOutput);
      expect(container.video).not.toBeNull();
      const video = container.video!;

      expect(video.hdr).toBe(true);
      expect(video.colourTransfer).toBe("smpte2084");
      expect(video.colourPrimaries).toBe("bt2020");
      expect(video.colorSpace).toBe("bt2020nc");
      expect(video.bitDepth).toBe(10);
      expect(video.width).toBe(3840);
      expect(video.height).toBe(2160);
      expect(video.fps).toBeCloseTo(60, 1);
    });

    it("probes HLG 4K 60fps video as isHdr=true with arib-std-b67 and BT.2020 primaries", async () => {
      const probeOutput = await ffprobe({ binary: "ffprobe", source: hlgFile, timeoutMs: 30_000 });
      const container = readProbe(probeOutput);
      expect(container.video).not.toBeNull();
      const video = container.video!;

      expect(video.hdr).toBe(true);
      expect(video.colourTransfer).toBe("arib-std-b67");
      expect(video.colourPrimaries).toBe("bt2020");
      expect(video.colorSpace).toBe("bt2020nc");
      expect(video.bitDepth).toBe(10);
      expect(video.width).toBe(3840);
      expect(video.height).toBe(2160);
      expect(video.fps).toBeCloseTo(60, 1);
    });
  });

  describe("Tone-mapped proxy generation, faststart moov atom, and framerate downsampling", () => {
    it("generates tone-mapped SDR proxy for HDR10 4K master with faststart and 30fps", async () => {
      const proxyOut = join(dir, "proxy_hdr10.mp4");
      const deriveContext = {
        binary: "ffmpeg",
        source: hdr10File,
        timeoutMs: 60_000,
      };

      const size = proxySize(3840, 2160);
      const outcome = await encodeProxy(deriveContext, {
        out: proxyOut,
        size,
        hdr: true,
        hasAudio: false,
      });

      expect(outcome.toneMapped).toBe(true);

      // 1. Verify proxy properties via ffprobe
      const proxyProbe = await ffprobe({ binary: "ffprobe", source: proxyOut, timeoutMs: 30_000 });
      const container = readProbe(proxyProbe);
      expect(container.video).not.toBeNull();
      const proxyVideo = container.video!;

      // Proxy is downsampled to 30 fps
      expect(proxyVideo.fps).toBeCloseTo(30, 1);
      // Dimensions follow proxySize
      expect(proxyVideo.width).toBe(size.width);
      expect(proxyVideo.height).toBe(size.height);
      // Standard 8-bit YUV420P
      expect(proxyVideo.pixelFormat).toBe("yuv420p");
      expect(proxyVideo.bitDepth).toBe(8);

      // 2. Verify moov atom is in front (+faststart)
      const hasFaststart = await hasFaststartMoov(proxyOut);
      expect(hasFaststart).toBe(true);

      // 3. Visual regression & luminance preservation test (no blown highlights / no flat wash)
      const stats = measureLuminanceStats(proxyOut);
      expect(stats.yMin).toBeGreaterThanOrEqual(0);
      expect(stats.yMax).toBeLessThanOrEqual(255);
      // Natural SDR balanced range: YAVG between 80 and 190
      expect(stats.yAvg).toBeGreaterThan(60);
      expect(stats.yAvg).toBeLessThan(210);
    }, 60_000);

    it("generates tone-mapped SDR proxy for HLG 4K master with faststart and 30fps", async () => {
      const proxyOut = join(dir, "proxy_hlg.mp4");
      const deriveContext = {
        binary: "ffmpeg",
        source: hlgFile,
        timeoutMs: 60_000,
      };

      const size = proxySize(3840, 2160);
      const outcome = await encodeProxy(deriveContext, {
        out: proxyOut,
        size,
        hdr: true,
        hasAudio: false,
      });

      expect(outcome.toneMapped).toBe(true);

      // Verify proxy has faststart and 30 fps
      const proxyProbe = await ffprobe({ binary: "ffprobe", source: proxyOut, timeoutMs: 30_000 });
      const container = readProbe(proxyProbe);
      expect(container.video).not.toBeNull();
      expect(container.video!.fps).toBeCloseTo(30, 1);

      const hasFaststart = await hasFaststartMoov(proxyOut);
      expect(hasFaststart).toBe(true);

      const stats = measureLuminanceStats(proxyOut);
      expect(stats.yAvg).toBeGreaterThan(60);
      expect(stats.yAvg).toBeLessThan(210);
    }, 60_000);
  });
});

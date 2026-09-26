import { describe, expect, it } from "vitest";

import { buildArgs, chooseFormat, FALLBACK_FORMAT, type ProbeFormat } from "./yt-dlp.js";

/**
 * Real rows from the probe of the video that failed on 2026-09-25
 * (youtube 5eW6Eagr9XA, 1078 s): yt-dlp's default pick was 4K AV1 (401,
 * 538 MB) + audio, 556 MB, over the Free plan's 500 MB cap.
 */
const DURATION_S = 1078;
const FORMATS: ProbeFormat[] = [
  {"format_id": "139", "vcodec": "none", "acodec": "mp4a.40.5", "ext": "m4a", "protocol": "https", "filesize": 6576677, "filesize_approx": 6576641, "tbr": 48.789, "abr": 48.789, "format_note": "low"},
  {"format_id": "140-drc", "vcodec": "none", "acodec": "mp4a.40.2", "ext": "m4a", "protocol": "https", "filesize": 17452022, "filesize_approx": 17451924, "tbr": 129.476, "abr": 129.476, "format_note": "medium, DRC"},
  {"format_id": "140", "vcodec": "none", "acodec": "mp4a.40.2", "ext": "m4a", "protocol": "https", "filesize": 17452022, "filesize_approx": 17451924, "tbr": 129.476, "abr": 129.476, "format_note": "medium"},
  {"format_id": "251", "vcodec": "none", "acodec": "opus", "ext": "webm", "protocol": "https", "filesize": 17400595, "filesize_approx": 17400571, "tbr": 129.101, "abr": 129.101, "format_note": "medium"},
  {"format_id": "133", "vcodec": "avc1.4d4015", "acodec": "none", "height": 240, "ext": "mp4", "protocol": "https", "filesize": 11429627, "filesize_approx": 11429510, "tbr": 84.801, "abr": 0, "format_note": "240p"},
  {"format_id": "134", "vcodec": "avc1.4d401e", "acodec": "none", "height": 360, "ext": "mp4", "protocol": "https", "filesize": 20826352, "filesize_approx": 20826263, "tbr": 154.52, "abr": 0, "format_note": "360p"},
  {"format_id": "135", "vcodec": "avc1.4d401e", "acodec": "none", "height": 480, "ext": "mp4", "protocol": "https", "filesize": 34581228, "filesize_approx": 34581139, "tbr": 256.574, "abr": 0, "format_note": "480p"},
  {"format_id": "136", "vcodec": "avc1.4d401f", "acodec": "none", "height": 720, "ext": "mp4", "protocol": "https", "filesize": 57574223, "filesize_approx": 57574132, "tbr": 427.17, "abr": 0, "format_note": "720p"},
  {"format_id": "398", "vcodec": "av01.0.05M.08", "acodec": "none", "height": 720, "ext": "mp4", "protocol": "https", "filesize": 49176290, "filesize_approx": 49176237, "tbr": 364.862, "abr": 0, "format_note": "720p"},
  {"format_id": "270", "vcodec": "avc1.640028", "acodec": "none", "height": 1080, "ext": "mp4", "protocol": "m3u8_native", "tbr": 4686.245, "abr": 0},
  {"format_id": "137", "vcodec": "avc1.640028", "acodec": "none", "height": 1080, "ext": "mp4", "protocol": "https", "filesize": 170219237, "filesize_approx": 170219122, "tbr": 1262.937, "abr": 0, "format_note": "1080p"},
  {"format_id": "248", "vcodec": "vp9", "acodec": "none", "height": 1080, "ext": "webm", "protocol": "https", "filesize": 111658538, "filesize_approx": 111658532, "tbr": 828.448, "abr": 0, "format_note": "1080p"},
  {"format_id": "399", "vcodec": "av01.0.08M.08", "acodec": "none", "height": 1080, "ext": "mp4", "protocol": "https", "filesize": 84892689, "filesize_approx": 84892632, "tbr": 629.859, "abr": 0, "format_note": "1080p"},
  {"format_id": "400", "vcodec": "av01.0.12M.08", "acodec": "none", "height": 1440, "ext": "mp4", "protocol": "https", "filesize": 266526922, "filesize_approx": 266526843, "tbr": 1977.49, "abr": 0, "format_note": "1440p"},
  {"format_id": "401", "vcodec": "av01.0.12M.08", "acodec": "none", "height": 2160, "ext": "mp4", "protocol": "https", "filesize": 538391240, "filesize_approx": 538391125, "tbr": 3994.581, "abr": 0, "format_note": "2160p"},
];
const FREE_CAP = 524_288_000;

describe("chooseFormat", () => {
  it("takes 1080p H.264 + AAC for the video yt-dlp would have fetched in 4K", () => {
    expect(chooseFormat(FORMATS, FREE_CAP, DURATION_S)).toEqual({
      selector: "137+140",
      height: 1080,
      bytes: expect.any(Number),
    });
    expect(chooseFormat(FORMATS, FREE_CAP, DURATION_S)?.bytes).toBeLessThan(FREE_CAP / 2);
  });

  it("never picks above 1080p, however much room there is", () => {
    const choice = chooseFormat(FORMATS, 10_000_000_000, DURATION_S);
    expect(choice?.height).toBe(1080);
  });

  it("steps down to a smaller picture rather than failing a long video", () => {
    const choice = chooseFormat(FORMATS, 60_000_000, DURATION_S);
    expect(choice?.height).toBe(480);
    expect(choice?.bytes).toBeLessThanOrEqual(60_000_000);
  });

  it("does not go below 360p when the source has better; the limit check refuses instead", () => {
    const choice = chooseFormat(FORMATS, 5_000_000, DURATION_S);
    expect(choice?.height).toBe(360);
    expect(choice?.bytes).toBeGreaterThan(5_000_000);
  });

  it("pairs the original-language AAC track, not the DRC or Opus one", () => {
    expect(chooseFormat(FORMATS, FREE_CAP, DURATION_S)?.selector.split("+")[1]).toBe("140");
  });

  it("uses a single muxed stream when the source has no separate audio", () => {
    const muxed: ProbeFormat[] = [
      { format_id: "hd", vcodec: "avc1", acodec: "mp4a", height: 720, ext: "mp4", filesize: 90e6 },
      { format_id: "sd", vcodec: "avc1", acodec: "mp4a", height: 360, ext: "mp4", filesize: 30e6 },
    ];
    expect(chooseFormat(muxed, FREE_CAP, 600)?.selector).toBe("hd");
  });

  it("estimates size from the bitrate when the source gives no size", () => {
    const noSize: ProbeFormat[] = [
      { format_id: "v", vcodec: "avc1", acodec: "none", height: 1080, tbr: 4000 },
      { format_id: "a", vcodec: "none", acodec: "mp4a", tbr: 128 },
    ];
    // 4.128 Mbit/s for 1000 s = 516 MB: over the 90% budget, and nothing smaller.
    const choice = chooseFormat(noSize, FREE_CAP, 1000);
    expect(choice?.bytes).toBe(516_000_000);
  });

  it("skips DRM-protected streams", () => {
    const drm: ProbeFormat[] = [
      { format_id: "drm", vcodec: "avc1", acodec: "mp4a", height: 1080, filesize: 1e6, has_drm: true },
      { format_id: "ok", vcodec: "avc1", acodec: "mp4a", height: 720, filesize: 1e6 },
    ];
    expect(chooseFormat(drm, FREE_CAP, 60)?.selector).toBe("ok");
  });

  it("returns null when there is nothing to choose from", () => {
    expect(chooseFormat([], FREE_CAP, 60)).toBeNull();
  });
});

describe("the download's format argument", () => {
  const limits = { maxBytes: FREE_CAP, maxDurationMs: 1_200_000, timeoutMs: 60_000 };
  const formatArg = (args: string[]): string | undefined => args[args.indexOf("-f") + 1];

  it("downloads exactly the streams the probe chose", () => {
    const args = buildArgs({ url: "https://youtu.be/x", outputPath: "/tmp/o.mp4", limits, format: "137+140" });
    expect(formatArg(args)).toBe("137+140");
  });

  it("falls back to a 1080p-capped H.264-first selector", () => {
    const args = buildArgs({ url: "https://youtu.be/x", outputPath: "/tmp/o.mp4", limits });
    expect(formatArg(args)).toBe(FALLBACK_FORMAT);
    expect(FALLBACK_FORMAT).toContain("height<=1080");
  });

  it("refuses a selector that is not format ids", () => {
    expect(() =>
      buildArgs({ url: "https://youtu.be/x", outputPath: "/tmp/o.mp4", limits, format: "b --exec x" }),
    ).toThrow("unexpected format selector");
  });
});

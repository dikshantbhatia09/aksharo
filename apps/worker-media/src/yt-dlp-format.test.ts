import { describe, expect, it } from "vitest";

import {
  ASSUMED_DOWNLOAD_BYTES_PER_S,
  buildArgs,
  chooseFormat,
  FALLBACK_FORMAT,
  FALLBACK_SORT,
  type ProbeFormat,
} from "./yt-dlp.js";

/**
 * Real rows from the probe of the video that failed on 2026-09-25
 * (youtube 5eW6Eagr9XA, 1078 s): yt-dlp's default pick was 4K AV1 (401,
 * 538 MB) + audio, 556 MB, over the Free plan's 500 MB cap.
 *
 * The capture kept no `width`s. A format without one is read as landscape,
 * which this 16:9 talk is, so the rows stand as they were recorded.
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

/**
 * The API's `ACQUIRE_TIMEOUT_MS`: every acquisition gets 40 minutes, whatever
 * the plan's byte cap.
 */
const ACQUIRE_TIMEOUT_MS = 40 * 60 * 1000;
const within = (maxBytes: number): { maxBytes: number; timeoutMs: number } => ({
  maxBytes,
  timeoutMs: ACQUIRE_TIMEOUT_MS,
});

/** The largest paid plan's byte cap (8 GiB), with its 6-hour duration limit. */
const LARGEST_CAP = 8 * 1024 ** 3;

/**
 * The same talk at three hours, the length a paid plan admits: the real rows
 * with their sizes taken away, so each is estimated from its real bitrate —
 * 4K AV1 + audio 5.6 GB, 1440p AV1 + audio 2.8 GB, 1080p H.264 + audio 1.9 GB.
 */
const LONG_S = 3 * 60 * 60;
const LONG_FORMATS: ProbeFormat[] = FORMATS.map(
  ({ filesize: _filesize, filesize_approx: _approx, ...rest }) => rest,
);

/**
 * A Short's format list (45 s, 1080 x 1920), in the shape YouTube gives one:
 * `height` is the LONG side, so 137 is "1920 tall". The sizes are
 * illustrative, not captured.
 */
const SHORT_S = 45;
const SHORT_FORMATS: ProbeFormat[] = [
  { format_id: "140", vcodec: "none", acodec: "mp4a.40.2", ext: "m4a", protocol: "https", filesize: 730_000, abr: 129, format_note: "medium" },
  { format_id: "251", vcodec: "none", acodec: "opus", ext: "webm", protocol: "https", filesize: 700_000, abr: 125, format_note: "medium" },
  { format_id: "18", vcodec: "avc1.42001E", acodec: "mp4a.40.2", width: 360, height: 640, ext: "mp4", protocol: "https", filesize: 3_000_000 },
  { format_id: "134", vcodec: "avc1.4d401e", acodec: "none", width: 360, height: 640, ext: "mp4", protocol: "https", filesize: 2_500_000 },
  { format_id: "135", vcodec: "avc1.4d401f", acodec: "none", width: 480, height: 854, ext: "mp4", protocol: "https", filesize: 4_500_000 },
  { format_id: "244", vcodec: "vp9", acodec: "none", width: 480, height: 854, ext: "webm", protocol: "https", filesize: 3_500_000 },
  { format_id: "136", vcodec: "avc1.4d401f", acodec: "none", width: 720, height: 1280, ext: "mp4", protocol: "https", filesize: 9_000_000 },
  { format_id: "137", vcodec: "avc1.640028", acodec: "none", width: 1080, height: 1920, ext: "mp4", protocol: "https", filesize: 20_000_000 },
  { format_id: "248", vcodec: "vp9", acodec: "none", width: 1080, height: 1920, ext: "webm", protocol: "https", filesize: 14_000_000 },
];

describe("chooseFormat", () => {
  it("takes 1440p within the Free cap for the video yt-dlp would have fetched in 4K", () => {
    // 4K AV1 + audio is 556 MB, over the cap. 1080p H.264 fits too, but a
    // clip is only as tall as its source: 1440p gives 810 x 1440, 1080p 608 x 1080.
    expect(chooseFormat(FORMATS, within(FREE_CAP), DURATION_S)).toEqual({
      selector: "400+140",
      height: 1440,
      shortSide: 1440,
      bytes: 266_526_922 + 17_452_022,
    });
    expect(chooseFormat(FORMATS, within(FREE_CAP), DURATION_S)?.bytes).toBeLessThan(FREE_CAP * 0.9);
  });

  it("takes 4K when it fits — the only size that fills a 1080 x 1920 clip — and nothing larger", () => {
    const with8k: ProbeFormat[] = [
      ...FORMATS,
      { format_id: "571", vcodec: "av01.0.16M.08", acodec: "none", width: 7680, height: 4320, ext: "mp4", protocol: "https", filesize: 900_000_000 },
    ];
    expect(chooseFormat(with8k, within(10_000_000_000), DURATION_S)).toMatchObject({
      selector: "401+140",
      shortSide: 2160,
    });
  });

  it("takes nothing above 1080p that could not arrive inside the download's time limit", () => {
    // 5.6 GB of 4K fits an 8 GiB cap, but landing it in 40 minutes needs
    // 18 Mbit/s sustained; a timeout is retried on the one shared slot and
    // then fails a run 1080p would have finished. 1440p (2.8 GB) is over the
    // 2.16 GB that 8 Mbit/s delivers too, so this takes 1080p H.264.
    expect(chooseFormat(LONG_FORMATS, within(LARGEST_CAP), LONG_S)).toMatchObject({
      selector: "137+140",
      shortSide: 1080,
    });
    // The time limit is what decided it: given three hours, 4K would do.
    expect(
      chooseFormat(LONG_FORMATS, { maxBytes: LARGEST_CAP, timeoutMs: 3 * 60 * 60 * 1000 }, LONG_S),
    ).toMatchObject({ selector: "401+140", shortSide: 2160 });
    // And an hour of it, 1.9 GB of 4K, arrives in time at 8 Mbit/s.
    expect(chooseFormat(LONG_FORMATS, within(LARGEST_CAP), 60 * 60)).toMatchObject({
      selector: "401+140",
    });
  });

  it("holds 1080p to the byte cap alone, as before anything larger was fetched", () => {
    // 1.9 GB of 1080p is inside the time budget anyway; six hours of it is not,
    // and is still what a 6-hour plan asked to be fetched.
    const choice = chooseFormat(LONG_FORMATS, within(LARGEST_CAP), 6 * 60 * 60);
    expect(choice).toMatchObject({ selector: "137+140", shortSide: 1080 });
    const inFortyMinutes = (ACQUIRE_TIMEOUT_MS / 1000) * ASSUMED_DOWNLOAD_BYTES_PER_S;
    expect(choice?.bytes).toBeGreaterThan(inFortyMinutes);
  });

  it("prefers H.264 only between pictures of the same size", () => {
    // 1440p (284 MB) is over a 250 MB cap's budget; of the 1080p streams that
    // fit, H.264 comes before the smaller VP9 and AV1 ones.
    expect(chooseFormat(FORMATS, within(250_000_000), DURATION_S)).toMatchObject({
      selector: "137+140",
      shortSide: 1080,
    });
  });

  it("steps down to a smaller picture rather than failing a long video", () => {
    const choice = chooseFormat(FORMATS, within(60_000_000), DURATION_S);
    expect(choice?.height).toBe(480);
    expect(choice?.bytes).toBeLessThanOrEqual(60_000_000);
  });

  it("measures a portrait video by its short side: a Short comes down at 1080 x 1920", () => {
    // Capped on height, 1920 was "over 1080p" and this took 135 at 480 x 854.
    expect(chooseFormat(SHORT_FORMATS, within(FREE_CAP), SHORT_S)).toEqual({
      selector: "137+140",
      height: 1920,
      shortSide: 1080,
      bytes: 20_730_000,
    });
  });

  it("steps a Short down by its short side too, to 720 x 1280 under a tight cap", () => {
    // Budget 10.8 MB: 137 (20.7 MB) and 248 (14.7 MB) are over, 136 fits.
    expect(chooseFormat(SHORT_FORMATS, within(12_000_000), SHORT_S)).toMatchObject({
      selector: "136+140",
      height: 1280,
      shortSide: 720,
    });
  });

  it("takes nothing above 1080p when no stream says what it costs", () => {
    // Nothing shows that 4K fits, and 4K is what blew the cap.
    const unsized: ProbeFormat[] = [
      { format_id: "uhd", vcodec: "av01", acodec: "none", width: 3840, height: 2160 },
      { format_id: "qhd", vcodec: "av01", acodec: "none", width: 2560, height: 1440 },
      { format_id: "fhd", vcodec: "avc1", acodec: "none", width: 1920, height: 1080 },
      { format_id: "hd", vcodec: "avc1", acodec: "none", width: 1280, height: 720 },
      { format_id: "a", vcodec: "none", acodec: "mp4a" },
    ];
    expect(chooseFormat(unsized, within(FREE_CAP), null)).toMatchObject({
      selector: "fhd+a",
      shortSide: 1080,
      bytes: null,
    });
    // And the least of what there is, when everything is larger.
    const onlyLarge = unsized.filter((f) => f.format_id !== "fhd" && f.format_id !== "hd");
    expect(chooseFormat(onlyLarge, within(FREE_CAP), null)?.selector).toBe("qhd+a");
  });

  it("takes the preferred stream of the least size there is, not the last one", () => {
    // Sorted largest first and best first within a size, the pool's last entry
    // is the WORST stream of the smallest size: here AV1 over HLS.
    const onlyLarge: ProbeFormat[] = [
      { format_id: "uhd", vcodec: "avc1", acodec: "none", width: 3840, height: 2160, protocol: "https" },
      { format_id: "qhd-av1", vcodec: "av01", acodec: "none", width: 2560, height: 1440, protocol: "m3u8_native" },
      { format_id: "qhd-avc", vcodec: "avc1", acodec: "none", width: 2560, height: 1440, protocol: "https" },
      { format_id: "a", vcodec: "none", acodec: "mp4a" },
    ];
    expect(chooseFormat(onlyLarge, within(FREE_CAP), null)).toMatchObject({
      selector: "qhd-avc+a",
      shortSide: 1440,
    });
  });

  it("does not go below 360p when the source has better; the limit check refuses instead", () => {
    const choice = chooseFormat(FORMATS, within(5_000_000), DURATION_S);
    expect(choice?.height).toBe(360);
    expect(choice?.bytes).toBeGreaterThan(5_000_000);
  });

  it("pairs the original-language AAC track, not the DRC or Opus one", () => {
    expect(chooseFormat(FORMATS, within(FREE_CAP), DURATION_S)?.selector.split("+")[1]).toBe("140");
  });

  it("uses a single muxed stream when the source has no separate audio", () => {
    const muxed: ProbeFormat[] = [
      { format_id: "hd", vcodec: "avc1", acodec: "mp4a", height: 720, ext: "mp4", filesize: 90e6 },
      { format_id: "sd", vcodec: "avc1", acodec: "mp4a", height: 360, ext: "mp4", filesize: 30e6 },
    ];
    expect(chooseFormat(muxed, within(FREE_CAP), 600)?.selector).toBe("hd");
  });

  it("estimates size from the bitrate when the source gives no size", () => {
    const noSize: ProbeFormat[] = [
      { format_id: "v", vcodec: "avc1", acodec: "none", height: 1080, tbr: 4000 },
      { format_id: "a", vcodec: "none", acodec: "mp4a", tbr: 128 },
    ];
    // 4.128 Mbit/s for 1000 s = 516 MB: over the 90% budget, and nothing smaller.
    const choice = chooseFormat(noSize, within(FREE_CAP), 1000);
    expect(choice?.bytes).toBe(516_000_000);
  });

  it("skips DRM-protected streams", () => {
    const drm: ProbeFormat[] = [
      { format_id: "drm", vcodec: "avc1", acodec: "mp4a", height: 1080, filesize: 1e6, has_drm: true },
      { format_id: "ok", vcodec: "avc1", acodec: "mp4a", height: 720, filesize: 1e6 },
    ];
    expect(chooseFormat(drm, within(FREE_CAP), 60)?.selector).toBe("ok");
  });

  it("returns null when there is nothing to choose from", () => {
    expect(chooseFormat([], within(FREE_CAP), 60)).toBeNull();
  });
});

describe("the download's format argument", () => {
  const limits = { maxBytes: FREE_CAP, maxDurationMs: 1_200_000, timeoutMs: 60_000 };
  const formatArg = (args: string[]): string | undefined => args[args.indexOf("-f") + 1];

  it("downloads exactly the streams the probe chose", () => {
    const args = buildArgs({ url: "https://youtu.be/x", outputPath: "/tmp/o.mp4", limits, format: "137+140" });
    expect(formatArg(args)).toBe("137+140");
    // Exact ids: there is nothing for a sort to rank.
    expect(args).not.toContain("-S");
  });

  it("falls back to yt-dlp's own chooser, ranked by the short side and H.264 first", () => {
    const args = buildArgs({ url: "https://youtu.be/x", outputPath: "/tmp/o.mp4", limits });
    expect(formatArg(args)).toBe(FALLBACK_FORMAT);
    // A height filter is a portrait video's LONG side: it took a Short at
    // 480 x 854. The sort's `res` is the short side.
    expect(FALLBACK_FORMAT).not.toContain("height");
    expect(args[args.indexOf("-S") + 1]).toBe(FALLBACK_SORT);
    expect(FALLBACK_SORT).toBe("res:1080,+codec:avc:m4a");
    expect(args.indexOf("-S")).toBeLessThan(args.indexOf("--"));
  });

  it("refuses a selector that is not format ids", () => {
    expect(() =>
      buildArgs({ url: "https://youtu.be/x", outputPath: "/tmp/o.mp4", limits, format: "b --exec x" }),
    ).toThrow("unexpected format selector");
  });
});

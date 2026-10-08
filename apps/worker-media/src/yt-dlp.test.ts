import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "./logger.js";
import { assertAcquirableUrl, readWindow } from "./processors/acquire.js";
import {
  DownloaderUnusableError,
  EXPECTED_EJS_VERSION,
  EXPECTED_SHA256,
  EXPECTED_VERSION,
  NEVER_ALLOWED_ARGS,
  REQUIRED_ARGS,
  assertDownloaderHeader,
  assertLockedDown,
  assertNoForbiddenArgs,
  assertWithinLimits,
  buildArgs,
  buildHeaderArgs,
  buildProbeArgs,
  classify,
  formatSeconds,
  isTooSlow,
  mostReplayedPeakMs,
  parseMediaTime,
  parseProgress,
  planSection,
  proxyArgs,
  readDownloaderHeader,
  FAST_AUDIO_FORMAT,
} from "./yt-dlp.js";

import type {
  AcquireLimits,
  AcquireWindow,
  DownloadPace,
  SectionPlan,
  SourceMetadata,
} from "./yt-dlp.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const NODE = "C:/Program Files/nodejs/node.exe";

/**
 * The pinned venv's own `-v` header, captured offline on the production host
 * (2026-09-27) with the lock-down every list carries.
 */
const REAL_HEADER = [
  "[debug] Command-line config: ['-v', '--encoding', 'utf-8', '--ignore-config', '--no-cache-dir', '--no-js-runtimes', '--js-runtimes', 'node:C:\\\\Program Files\\\\nodejs\\\\node.exe', '--no-remote-components', '--no-plugin-dirs']",
  "[debug] Encodings: locale cp1252, fs utf-8, pref utf-8, out cp1252 (No ANSI), error cp1252 (No ANSI), screen cp1252 (No ANSI)",
  "[debug] yt-dlp version stable@2026.08.19 from yt-dlp/yt-dlp [594bd50c2] (pip)",
  "[debug] Python 3.12.10 (CPython AMD64 64bit) - Windows-11-10.0.26200-SP0 (OpenSSL 3.0.16 11 Feb 2025)",
  "[debug] exe versions: ffmpeg 9.0-full_build-www.gyan.dev (setts), ffprobe 9.0-full_build-www.gyan.dev",
  "[debug] Optional libraries: Cryptodome-3.23.0, brotli-1.2.0, certifi-2026.07.22, mutagen-1.48.1, requests-2.34.2, sqlite3-3.49.1, urllib3-2.8.0, websockets-17.1, yt_dlp_ejs-0.8.0",
  "[debug] JS runtimes: node-24.19.0",
  "[debug] Proxy map: {}",
  "[debug] Request Handlers: urllib, requests, websockets",
  "[debug] Plugin directories: none (disabled)",
  "[debug] Loaded 1744 extractors",
  "",
  "Usage: yt-dlp [OPTIONS] URL [URL...]",
  "",
  "yt-dlp: error: You must provide at least one URL.",
].join("\n");

/**
 * REP-010's security surface, tested where it is decidable.
 *
 * What is NOT here is a real download: that needs the pinned binary, the network
 * and a rights-cleared video, and the plan puts it in an isolated staging spike
 * (§14 Wave 3) rather than in a unit suite. What IS here is every rule that can
 * be checked without running anything — the argument list, the limits, the URL
 * boundary and the failure classification — because those are the rules that
 * decide whether running it is safe at all.
 */

const LIMITS: AcquireLimits = {
  maxBytes: 524_288_000,
  maxDurationMs: 1_200_000,
  timeoutMs: 900_000,
};

const SAFE_METADATA: SourceMetadata = {
  provider: "Youtube",
  sourceId: "dQw4w9WgXcQ",
  title: "Episode 12",
  channel: "Example",
  durationMs: 600_000,
  isLive: false,
  approximateBytes: 100_000_000,
};

describe("the argument list", () => {
  it("is a closed list with the URL as its only caller value", () => {
    const args = buildArgs({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      outputPath: "/tmp/montaj-acquire-x/source.mp4",
      limits: LIMITS,
    });

    // The URL is last, after `--`, so nothing in it can be read as a flag.
    expect(args.at(-1)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(args.at(-2)).toBe("--");

    // Everything else is a literal or a number this module formatted.
    const caller = args.filter(
      (arg) => arg.includes("youtube.com") || arg.includes("montaj-acquire"),
    );
    expect(caller).toEqual([
      "/tmp/montaj-acquire-x/source.mp4",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ]);
  });

  it("refuses a playlist, a live stream and a config file, every time", () => {
    const args = buildArgs({ url: "https://youtu.be/x", outputPath: "/tmp/o.mp4", limits: LIMITS });
    expect(args).toContain("--no-playlist");
    expect(args).toContain("--ignore-config");
    expect(args).toContain("--no-cache-dir");
    expect(args).toContain("--no-live-from-start");
    expect(args).toContain("--max-filesize");
    expect(args[args.indexOf("--max-filesize") + 1]).toBe("524288000");
  });

  it("never emits an argument that could run another program or update itself", () => {
    for (const builder of [
      () => buildArgs({ url: "https://youtu.be/x", outputPath: "/tmp/o.mp4", limits: LIMITS }),
      () => buildProbeArgs("https://youtu.be/x"),
      () => buildHeaderArgs(NODE),
      () =>
        buildArgs({
          url: "https://youtu.be/x",
          outputPath: "/tmp/o.mp4",
          limits: LIMITS,
          jsRuntime: NODE,
          section: { startMs: 0, endMs: 1_200_000 },
        }),
    ]) {
      const args = builder();
      for (const forbidden of NEVER_ALLOWED_ARGS) {
        expect(args, forbidden).not.toContain(forbidden);
      }
    }
  });

  it("clears every JavaScript runtime, then names the one node, in every list", () => {
    // A deno installed later must not quietly become the runtime YouTube's
    // scripts run in; clearing the defaults first is what stops it.
    for (const args of [
      buildArgs({
        url: "https://youtu.be/x",
        outputPath: "/tmp/o.mp4",
        limits: LIMITS,
        jsRuntime: NODE,
      }),
      buildProbeArgs("https://youtu.be/x", { jsRuntime: NODE }),
      buildHeaderArgs(NODE),
    ]) {
      const cleared = args.indexOf("--no-js-runtimes");
      const named = args.indexOf("--js-runtimes");
      expect(cleared).toBeGreaterThanOrEqual(0);
      expect(named).toBeGreaterThan(cleared);
      expect(args[named + 1]).toBe(`node:${NODE}`);
      expect(args.filter((arg) => arg === "--js-runtimes")).toHaveLength(1);
      if (args.includes("--")) expect(named).toBeLessThan(args.indexOf("--"));
    }
  });

  it("enables no runtime at all when none is configured, rather than yt-dlp's default", () => {
    for (const args of [
      buildArgs({ url: "https://youtu.be/x", outputPath: "/tmp/o.mp4", limits: LIMITS }),
      buildProbeArgs("https://youtu.be/x"),
      buildHeaderArgs(undefined),
    ]) {
      expect(args).toContain("--no-js-runtimes");
      expect(args).not.toContain("--js-runtimes");
    }
  });

  it("passes mobile player clients for YouTube extractor to bypass bot check", () => {
    for (const args of [
      buildArgs({ url: "https://youtu.be/x", outputPath: "/tmp/o.mp4", limits: LIMITS }),
      buildProbeArgs("https://youtu.be/x"),
    ]) {
      const at = args.indexOf("--extractor-args");
      expect(at).toBeGreaterThanOrEqual(0);
      expect(args[at + 1]).toBe("youtube:player_client=ios,android,web");
      expect(at).toBeLessThan(args.indexOf("--"));
    }

    const overridden = buildArgs({
      url: "https://youtu.be/x",
      outputPath: "/tmp/o.mp4",
      limits: LIMITS,
      youtubePlayerClient: "ios",
    });
    expect(overridden[overridden.indexOf("--extractor-args") + 1]).toBe("youtube:player_client=ios");

    const disabled = buildArgs({
      url: "https://youtu.be/x",
      outputPath: "/tmp/o.mp4",
      limits: LIMITS,
      youtubePlayerClient: "off",
    });
    expect(disabled).not.toContain("--extractor-args");
  });

  it("never fetches remote components or searches plugin directories", () => {
    for (const args of [
      buildArgs({
        url: "https://youtu.be/x",
        outputPath: "/tmp/o.mp4",
        limits: LIMITS,
        jsRuntime: NODE,
      }),
      buildProbeArgs("https://youtu.be/x", { jsRuntime: NODE }),
      buildHeaderArgs(NODE),
    ]) {
      for (const required of REQUIRED_ARGS) expect(args, required).toContain(required);
      expect(args).not.toContain("--remote-components");
      expect(args).not.toContain("--plugin-dirs");
    }
  });

  it("refuses remote components, plugin directories and any runtime it did not write", () => {
    const refused: (readonly string[])[] = [
      ["--no-js-runtimes", "--remote-components", "ejs:github"],
      ["--no-js-runtimes", "--remote-components=ejs:npm"],
      ["--no-js-runtimes", "--plugin-dirs", "C:/plugins"],
      // Another runtime, or node found on PATH rather than by path.
      ["--no-js-runtimes", "--js-runtimes", "deno"],
      ["--no-js-runtimes", "--js-runtimes", "node"],
      ["--no-js-runtimes", "--js-runtimes", "node:relative/node.exe"],
      // The `=` spelling, a second runtime, and one not cleared first.
      ["--no-js-runtimes", `--js-runtimes=node:${NODE}`],
      ["--no-js-runtimes", "--js-runtimes", `node:${NODE}`, "--js-runtimes", "node:/usr/bin/node"],
      ["--js-runtimes", `node:${NODE}`, "--no-js-runtimes"],
    ];
    for (const args of refused) {
      expect(() => {
        assertNoForbiddenArgs(args);
      }, args.join(" ")).toThrow(DownloaderUnusableError);
    }
    // The form the builders write, on either platform's absolute path.
    for (const path of [NODE, "/usr/bin/node"]) {
      expect(() => {
        assertNoForbiddenArgs(["--no-js-runtimes", "--js-runtimes", `node:${path}`]);
      }).not.toThrow();
    }
  });

  it("refuses a list that lost its lock-down, or carries it only after `--`", () => {
    const whole = buildProbeArgs("https://youtu.be/x");
    for (const required of REQUIRED_ARGS) {
      expect(() => {
        assertLockedDown(whole.filter((arg) => arg !== required));
      }, required).toThrow(/without/);
    }
    expect(() => {
      assertLockedDown(["--", ...REQUIRED_ARGS]);
    }).toThrow(/without/);
    expect(() => {
      assertLockedDown(whole);
    }).not.toThrow();
  });

  it("fetches a section as one bounded time range, before the URL", () => {
    const args = buildArgs({
      url: "https://youtu.be/x",
      outputPath: "/tmp/o.mp4",
      limits: LIMITS,
      format: "137+140",
      section: { startMs: 610_500, endMs: 1_810_500 },
    });
    const at = args.indexOf("--download-sections");
    expect(args[at + 1]).toBe("*610.500-1810.500");
    expect(at).toBeLessThan(args.indexOf("--"));
    // Only one caller-derived value besides the URL and the output path.
    expect(args.filter((arg) => arg.startsWith("*"))).toEqual(["*610.500-1810.500"]);
    // The whole-file list has none.
    expect(
      buildArgs({ url: "https://youtu.be/x", outputPath: "/tmp/o.mp4", limits: LIMITS }),
    ).not.toContain("--download-sections");
  });

  it("refuses a section that is not two ordered whole milliseconds inside a day", () => {
    for (const section of [
      { startMs: -1, endMs: 1_000 },
      { startMs: 1.5, endMs: 1_000 },
      { startMs: 5_000, endMs: 5_000 },
      { startMs: 5_000, endMs: 4_000 },
      { startMs: 0, endMs: 86_400_001 },
      { startMs: Number.NaN, endMs: 1_000 },
    ]) {
      expect(
        () =>
          buildArgs({
            url: "https://youtu.be/x",
            outputPath: "/tmp/o.mp4",
            limits: LIMITS,
            section,
          }),
        JSON.stringify(section),
      ).toThrow(DownloaderUnusableError);
    }
  });

  it("formats seconds from checked integers only", () => {
    expect(formatSeconds(0)).toBe("0.000");
    expect(formatSeconds(1_200_000)).toBe("1200.000");
    expect(formatSeconds(61_001)).toBe("61.001");
    expect(() => formatSeconds(0.5)).toThrow(DownloaderUnusableError);
  });

  it("refuses a list that somebody added a forbidden flag to", () => {
    // The guard runs on the BUILT list, so a future edit to a builder cannot
    // reintroduce one of these by accident.
    for (const forbidden of ["--exec", "--update", "--cookies-from-browser"]) {
      expect(() => {
        assertNoForbiddenArgs(["--no-playlist", forbidden, "--", "https://youtu.be/x"]);
      }, forbidden).toThrow(/refusing to run the downloader/);
    }
    expect(() => {
      assertNoForbiddenArgs(["--exec=rm -rf /", "--", "https://youtu.be/x"]);
    }).toThrow();
  });

  it("fetches metadata without fetching bytes", () => {
    const args = buildProbeArgs("https://youtu.be/x");
    expect(args).toContain("--skip-download");
    expect(args).toContain("--dump-single-json");
    expect(args).not.toContain("-o");
  });

  it("has yt-dlp write UTF-8 to its pipes, whatever the host's code page", () => {
    // Without it, YouTube's curly apostrophe arrived as U+FFFD on Windows and
    // "channel’s members" could never match anything.
    for (const args of [
      buildArgs({ url: "https://youtu.be/x", outputPath: "/tmp/o.mp4", limits: LIMITS }),
      buildProbeArgs("https://youtu.be/x"),
    ]) {
      expect(args[args.indexOf("--encoding") + 1]).toBe("utf-8");
      expect(args.indexOf("--encoding")).toBeLessThan(args.indexOf("--"));
    }
  });

  it("keeps warnings, so an operator can see a YouTube change coming", () => {
    // "--no-warnings" hid the one line that said formats may be missing.
    expect(
      buildArgs({ url: "https://youtu.be/x", outputPath: "/tmp/o.mp4", limits: LIMITS }),
    ).not.toContain("--no-warnings");
    expect(buildProbeArgs("https://youtu.be/x")).not.toContain("--no-warnings");
  });

  it("merges with the ffmpeg the worker checked, when one is configured by path", () => {
    for (const ffmpegPath of ["C:/tools/ffmpeg/bin/ffmpeg.exe", "/usr/local/bin/ffmpeg"]) {
      const args = buildArgs({
        url: "https://youtu.be/x",
        outputPath: "/tmp/o.mp4",
        limits: LIMITS,
        ffmpegPath,
      });
      expect(args[args.indexOf("--ffmpeg-location") + 1], ffmpegPath).toBe(ffmpegPath);
      // Still before `--`, so it cannot be mistaken for the URL or vice versa.
      expect(args.indexOf("--ffmpeg-location")).toBeLessThan(args.indexOf("--"));
    }
  });

  it("leaves a bare ffmpeg name to PATH, which yt-dlp would read as 'no ffmpeg'", () => {
    // yt-dlp checks the location exists on disk; `ffmpeg` does not, so passing
    // it would switch merging OFF on the machine that runs production.
    for (const ffmpegPath of ["ffmpeg", undefined]) {
      const args = buildArgs({
        url: "https://youtu.be/x",
        outputPath: "/tmp/o.mp4",
        limits: LIMITS,
        ...(ffmpegPath === undefined ? {} : { ffmpegPath }),
      });
      expect(args, String(ffmpegPath)).not.toContain("--ffmpeg-location");
    }
  });

  it("passes rotating proxy url safely before -- in buildArgs and buildProbeArgs", () => {
    const proxyUrl = "http://user:pass@proxy.example.com:8080";
    expect(proxyArgs(undefined)).toEqual([]);
    expect(proxyArgs("")).toEqual([]);
    expect(proxyArgs(proxyUrl)).toEqual(["--proxy", proxyUrl]);

    const args = buildArgs({
      url: "https://youtu.be/x",
      outputPath: "/tmp/o.mp4",
      limits: LIMITS,
      proxyUrl,
    });
    expect(args[args.indexOf("--proxy") + 1]).toBe(proxyUrl);
    expect(args.indexOf("--proxy")).toBeLessThan(args.indexOf("--"));

    const probeArgs = buildProbeArgs("https://youtu.be/x", { proxyUrl });
    expect(probeArgs[probeArgs.indexOf("--proxy") + 1]).toBe(proxyUrl);
    expect(probeArgs.indexOf("--proxy")).toBeLessThan(probeArgs.indexOf("--"));
  });

  it("configures fast audio extraction args for instant STT handoff", () => {
    const args = buildArgs({
      url: "https://youtu.be/x",
      outputPath: "/tmp/audio.wav",
      limits: LIMITS,
      audioOnly: true,
    });
    expect(args).toContain("--extract-audio");
    expect(args[args.indexOf("--audio-format") + 1]).toBe("wav");
    expect(args[args.indexOf("-f") + 1]).toBe(FAST_AUDIO_FORMAT);
    expect(args).not.toContain("--merge-output-format");
  });

  it("passes a hostile URL through as one argument rather than sanitising it", () => {
    // There is no shell, so this is a URL and not a command. The point of the
    // test is that the value is NOT split, quoted or rewritten on its way to
    // argv — `spawn` hands it to execve whole.
    const hostile = "https://youtu.be/x;rm%20-rf%20/&&curl%20evil";
    const args = buildArgs({ url: hostile, outputPath: "/tmp/o.mp4", limits: LIMITS });
    expect(args.at(-1)).toBe(hostile);
    expect(args.filter((arg) => arg.includes("rm -rf"))).toEqual([]);
  });
});

describe("limits", () => {
  it("accepts a source inside every limit", () => {
    expect(() => {
      assertWithinLimits(SAFE_METADATA, LIMITS);
    }).not.toThrow();
  });

  it("refuses a live stream, whichever field says so", () => {
    expect(() => {
      assertWithinLimits({ ...SAFE_METADATA, isLive: true }, LIMITS);
    }).toThrow(/live stream/);
  });

  it("refuses a source longer than the plan allows", () => {
    expect(() => {
      assertWithinLimits({ ...SAFE_METADATA, durationMs: 3_600_000 }, LIMITS);
    }).toThrow(/longer than your plan/);
  });

  it("refuses a source larger than the plan allows", () => {
    expect(() => {
      assertWithinLimits({ ...SAFE_METADATA, approximateBytes: 2_000_000_000 }, LIMITS);
    }).toThrow(/larger than your plan/);
  });

  it("names each refusal, so the run can say which way and what to do next", () => {
    // All three used to be `media/unsupported` ("choose another video"), which
    // is the wrong advice for a video that is merely too big for the plan.
    const refusal = (metadata: SourceMetadata): unknown => {
      try {
        assertWithinLimits(metadata, LIMITS);
      } catch (error) {
        return error;
      }
      return null;
    };
    expect(refusal({ ...SAFE_METADATA, isLive: true })).toMatchObject({
      reason: "media/source_live",
      retryable: false,
    });
    expect(refusal({ ...SAFE_METADATA, durationMs: 3_600_000 })).toMatchObject({
      reason: "media/too_long",
      retryable: false,
    });
    expect(refusal({ ...SAFE_METADATA, approximateBytes: 2_000_000_000 })).toMatchObject({
      reason: "media/too_large",
      retryable: false,
    });
  });

  it("does not refuse a source that simply did not say how big it is", () => {
    // Unknown is not "too big": the real size is measured after the download,
    // and refusing here would reject every source with sparse metadata.
    expect(() => {
      assertWithinLimits({ ...SAFE_METADATA, approximateBytes: null, durationMs: null }, LIMITS);
    }).not.toThrow();
  });

  it("carries the numbers behind a refusal, so the page can state them", () => {
    // "This video is 34:37; your plan processes 20:00" needs both numbers.
    const refusal = (metadata: SourceMetadata): unknown => {
      try {
        assertWithinLimits(metadata, LIMITS);
      } catch (error) {
        return error;
      }
      return null;
    };
    expect(refusal({ ...SAFE_METADATA, durationMs: 2_077_000 })).toMatchObject({
      facts: {
        durationMs: 2_077_000,
        maxDurationMs: 1_200_000,
        approximateBytes: 100_000_000,
        maxBytes: 524_288_000,
      },
    });
    // What is not known is left out, never sent as a number.
    const unsized = refusal({ ...SAFE_METADATA, durationMs: 2_077_000, approximateBytes: null });
    expect((unsized as { facts: Record<string, unknown> }).facts).not.toHaveProperty(
      "approximateBytes",
    );
    expect(refusal({ ...SAFE_METADATA, approximateBytes: 2_000_000_000 })).toMatchObject({
      reason: "media/too_large",
      facts: { approximateBytes: 2_000_000_000, maxBytes: 524_288_000 },
    });
  });
});

describe("the window", () => {
  // A 34:37 video against the Free plan's 20:00.
  const DURATION = 2_077_000;
  const TWENTY = 1_200_000;

  /** Twenty minutes of `durationMs` (the 34:37 video unless said), by `policy`. */
  const plan = (
    window: Omit<AcquireWindow, "maxMs">,
    replayedPeakMs: number | null,
    durationMs = DURATION,
  ): SectionPlan | null =>
    planSection({ durationMs, window: { maxMs: TWENTY, ...window }, replayedPeakMs });

  it("leaves a source that fits alone", () => {
    expect(plan({ policy: "first" }, null, 1_078_000)).toBeNull();
    expect(plan({ policy: "most_replayed" }, 5_000, TWENTY)).toBeNull();
    expect(plan({ policy: "range" }, null, 1_078_000)).toBeNull();
    expect(plan({ policy: "range", startMs: 0 }, null, 1_078_000)).toBeNull();
  });

  it("honours a start picked on a source that fits, from there to the end", () => {
    // 5:00 on a 17:58 video is 5:00-17:58, not the whole video from 0:00.
    expect(plan({ policy: "range", startMs: 300_000 }, null, 1_078_000)).toEqual({
      startMs: 300_000,
      endMs: 1_078_000,
      sourceDurationMs: 1_078_000,
      policy: "range",
    });
    // A start with less than a section after it takes the whole video.
    expect(plan({ policy: "range", startMs: 1_075_000 }, null, 1_078_000)).toBeNull();
  });

  it("takes the first minutes by default", () => {
    expect(plan({ policy: "first" }, 1_500_000)).toEqual({
      startMs: 0,
      endMs: TWENTY,
      sourceDurationMs: DURATION,
      policy: "first",
    });
  });

  it("centres on the most-replayed moment, slid to fit inside the video", () => {
    // Peak at 15:00: 5:00-25:00.
    expect(plan({ policy: "most_replayed" }, 900_000)).toEqual({
      startMs: 300_000,
      endMs: 1_500_000,
      sourceDurationMs: DURATION,
      policy: "most_replayed",
    });
    // Peak at 33:00 would run off the end: the last full 20 minutes.
    expect(plan({ policy: "most_replayed" }, 1_980_000)).toMatchObject({
      startMs: DURATION - TWENTY,
      endMs: DURATION,
    });
    // Peak at 0:30 would start before it: from the start.
    expect(plan({ policy: "most_replayed" }, 30_000)).toMatchObject({ startMs: 0, endMs: TWENTY });
  });

  it("says it took the start when there was no heatmap to centre on", () => {
    expect(plan({ policy: "most_replayed" }, null)).toEqual({
      startMs: 0,
      endMs: TWENTY,
      sourceDurationMs: DURATION,
      policy: "first",
    });
  });

  it("honours a chosen start, cutting the window short at the end rather than moving it", () => {
    // "Process the next 20 minutes" of a 34:37 video is 20:00-34:37.
    expect(plan({ policy: "range", startMs: TWENTY }, null)).toEqual({
      startMs: TWENTY,
      endMs: DURATION,
      sourceDurationMs: DURATION,
      policy: "range",
    });
    // A start with nothing after it takes the last full window instead.
    expect(plan({ policy: "range", startMs: DURATION - 2_000 }, null)).toMatchObject({
      startMs: DURATION - TWENTY,
      endMs: DURATION,
      policy: "range",
    });
    // A range with no start is the start.
    expect(plan({ policy: "range" }, null)).toMatchObject({ startMs: 0, policy: "first" });
  });

  it("reads the most-replayed peak out of the heatmap, ignoring rows it cannot trust", () => {
    const heatmap = [
      { start_time: 0, end_time: 20.77, value: 1 },
      { start_time: 600, end_time: 620, value: 0.4 },
      "not a row",
      { start_time: 900, end_time: 890, value: 9 },
      { start_time: 5_000, end_time: 5_020, value: 9 },
      { start_time: 1_200, end_time: "x", value: 9 },
      { start_time: 1_500, end_time: 1_520, value: Number.POSITIVE_INFINITY },
    ];
    // Backwards, past the end, non-numeric and infinite rows are all skipped.
    expect(mostReplayedPeakMs(heatmap, DURATION)).toBe(10_385);
    // The earliest of equal peaks, so a video always gets the same window.
    expect(
      mostReplayedPeakMs(
        [
          { start_time: 100, end_time: 110, value: 1 },
          { start_time: 200, end_time: 210, value: 1 },
        ],
        DURATION,
      ),
    ).toBe(105_000);
    expect(mostReplayedPeakMs(undefined, DURATION)).toBeNull();
    expect(mostReplayedPeakMs([], DURATION)).toBeNull();
  });

  it("refuses a malformed window from the payload before anything runs", () => {
    expect(readWindow(undefined)).toBeUndefined();
    expect(readWindow({ maxMs: TWENTY, policy: "range", startMs: 5_000 })).toEqual({
      maxMs: TWENTY,
      policy: "range",
      startMs: 5_000,
    });
    for (const window of [
      { maxMs: 0, policy: "first" },
      { maxMs: -5, policy: "first" },
      { maxMs: 1.5, policy: "first" },
      { maxMs: TWENTY, policy: "loudest" },
      { maxMs: TWENTY, policy: "range", startMs: -1 },
      { maxMs: 86_400_001, policy: "first" },
      "twenty minutes",
    ]) {
      expect(() => readWindow(window), JSON.stringify(window)).toThrow(/window/);
    }
  });
});

describe("the section's pace", () => {
  // Twenty minutes of video, 100 MB: at 2x it must land within 10 min + 15 s.
  const PACE: DownloadPace = { mediaMs: 1_200_000, expectedBytes: 100_000_000, minRealtime: 2 };
  const bytes = (landed: number): { bytes: number; mediaMs: null } => ({
    bytes: landed,
    mediaMs: null,
  });

  it("gives up past the deadline, whatever has landed short of all of it", () => {
    expect(isTooSlow(PACE, bytes(99_000_000), 615_001)).toBe(true);
    expect(isTooSlow({ ...PACE, expectedBytes: null }, bytes(0), 615_001)).toBe(true);
    expect(isTooSlow({ ...PACE, expectedBytes: null }, bytes(0), 600_000)).toBe(false);
  });

  it("never calls a section with all of its media slow, past the deadline or not", () => {
    // ffmpeg writing its index after the last frame, or yt-dlp tidying up.
    expect(isTooSlow(PACE, { bytes: 0, mediaMs: 1_200_000 }, 700_000)).toBe(false);
    expect(isTooSlow(PACE, bytes(100_000_000), 700_000)).toBe(false);
  });

  it("judges nothing by what has landed during the warm-up", () => {
    expect(isTooSlow(PACE, bytes(0), 59_999)).toBe(false);
  });

  it("knows a reader throttled to real time after a minute, not after ten", () => {
    // At 60 s, 2x needs (60 - 15) x 2 = 90 s of video landed: 7.5 MB.
    expect(isTooSlow(PACE, bytes(5_000_000), 60_000)).toBe(true); // 60 s of video: 1.3x
    expect(isTooSlow(PACE, bytes(10_000_000), 60_000)).toBe(false); // 120 s: 2.7x
  });

  it("judges by ffmpeg's own media time when it has printed one, not the average bitrate", () => {
    // A quiet stretch well below the video's average bitrate: 3 MB is 36 s by
    // the estimate, but ffmpeg has written 150 s — 3.3x, on pace.
    expect(isTooSlow(PACE, { bytes: 3_000_000, mediaMs: 150_000 }, 60_000)).toBe(false);
    // And the other way: bytes that look ahead, media time that is not.
    expect(isTooSlow(PACE, { bytes: 50_000_000, mediaMs: 60_000 }, 60_000)).toBe(true);
  });
});

describe("ffmpeg's media time", () => {
  it("reads time= out of a stats line, as ffmpeg 9 prints it", () => {
    expect(
      parseMediaTime(
        "frame= 7220 fps=120 q=-1.0 size=   81920KiB time=00:04:00.66 bitrate=2788.4kbits/s speed=4.01x elapsed=0:01:00.01",
      ),
    ).toBe(240_660);
    // Audio only: no frame count.
    expect(parseMediaTime("size=    1024KiB time=01:02:03.5 bitrate= 135.2kbits/s speed=2x")).toBe(
      3_723_500,
    );
  });

  it("reads nothing out of any other line, or out of time=N/A", () => {
    expect(parseMediaTime("frame=    0 fps=0.0 q=0.0 size=       0KiB time=N/A bitrate=N/A")).toBeNull();
    expect(parseMediaTime("[download] Destination: source.mp4")).toBeNull();
    expect(parseMediaTime("title: the time=00:01:00.00 of my life")).toBeNull();
  });
});

describe("the downloader's own header", () => {
  it("reads the version, the solver, the runtime and the plugins out of it", () => {
    expect(readDownloaderHeader(REAL_HEADER)).toEqual({
      version: "2026.08.19",
      ejsVersion: "0.8.0",
      jsRuntimes: "node-24.19.0",
      nodeVersion: "24.19.0",
      nodeUnsupported: false,
      pluginDirectories: "none (disabled)",
      plugins: [],
    });
  });

  it("accepts the pinned venv as it is installed on the production host", () => {
    expect(() => {
      assertDownloaderHeader(readDownloaderHeader(REAL_HEADER), { jsRuntime: NODE });
    }).not.toThrow();
    expect(EXPECTED_EJS_VERSION).toBe("0.8.0");
  });

  it("refuses when the named node does not show up, or is too old for the solver", () => {
    for (const runtimes of ["none (disabled)", "none", "node-18.0.0 (unsupported)"]) {
      const header = readDownloaderHeader(
        REAL_HEADER.replace("JS runtimes: node-24.19.0", `JS runtimes: ${runtimes}`),
      );
      expect(() => {
        assertDownloaderHeader(header, { jsRuntime: NODE });
      }, runtimes).toThrow(DownloaderUnusableError);
    }
  });

  it("refuses a runtime with no solver, or a solver that is not the pinned one", () => {
    const missing = readDownloaderHeader(REAL_HEADER.replace(", yt_dlp_ejs-0.8.0", ""));
    expect(() => {
      assertDownloaderHeader(missing, { jsRuntime: NODE });
    }).toThrow(/yt-dlp-ejs is not installed/);
    const other = readDownloaderHeader(REAL_HEADER.replace("yt_dlp_ejs-0.8.0", "yt_dlp_ejs-0.9.1"));
    expect(() => {
      assertDownloaderHeader(other, { jsRuntime: NODE });
    }).toThrow(/pinned to 0\.8\.0/);
    // Only where another yt-dlp is allowed anyway: they ship together.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(() => {
      assertDownloaderHeader(other, { jsRuntime: NODE, unpinnedAllowed: true });
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("refuses a downloader that loads plugins, runtime or not", () => {
    for (const header of [
      REAL_HEADER.replace(
        "Plugin directories: none (disabled)",
        "Plugin directories: C:/yt-dlp-plugins",
      ),
      REAL_HEADER.replace(
        "[debug] Loaded 1744 extractors",
        "[debug] Extractor Plugins: SneakyIE\n[debug] Loaded 1745 extractors",
      ),
    ]) {
      expect(() => {
        assertDownloaderHeader(readDownloaderHeader(header), {});
      }).toThrow(/plugins/);
    }
  });

  it("refuses something that answered -v without describing itself", () => {
    expect(() => {
      assertDownloaderHeader(readDownloaderHeader("2026.08.19\n"), {});
    }).toThrow(/no debug header/);
  });

  it("needs neither node nor the solver when no runtime is configured", () => {
    const bare = REAL_HEADER.replace(
      "JS runtimes: node-24.19.0",
      "JS runtimes: none (disabled)",
    ).replace(", yt_dlp_ejs-0.8.0", "");
    expect(() => {
      assertDownloaderHeader(readDownloaderHeader(bare), {});
    }).not.toThrow();
  });
});

describe("the worker's own URL check", () => {
  it("accepts the URL the API normalises every link to", () => {
    expect(assertAcquirableUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ").hostname).toBe(
      "www.youtube.com",
    );
  });

  it("refuses anything that is not HTTPS, even though the API already checked", () => {
    // §8.2: a worker never trusts a payload. A job can be replayed from the
    // dead-letter queue long after the code that built it changed.
    for (const url of [
      "http://www.youtube.com/watch?v=x",
      "file:///etc/passwd",
      "ftp://example.test/v.mp4",
      "not a url at all",
    ]) {
      expect(() => assertAcquirableUrl(url), url).toThrow();
    }
  });

  it("refuses credentials in the URL", () => {
    expect(() => assertAcquirableUrl("https://user:pass@youtube.com/watch?v=x")).toThrow(
      /username or password/,
    );
  });

  it("accepts one video on every host the API recognises as YouTube", () => {
    for (const url of [
      "https://youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "https://youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://WWW.YouTube.com/watch?v=a-b_c1D2e3F",
    ]) {
      expect(() => assertAcquirableUrl(url), url).not.toThrow();
    }
  });

  it("refuses anything on an allowed host that is not exactly one video", () => {
    // The host is not the whole boundary: YouTube has redirect endpoints, and
    // a path its extractor does not claim goes to yt-dlp's generic one, which
    // follows redirects anywhere. The API only ever sends /watch?v=<id>.
    for (const url of [
      "https://www.youtube.com/redirect?q=http%3A%2F%2F169.254.169.254%2F",
      "https://www.youtube.com/attribution_link?u=%2Fwatch%3Fv%3DdQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL0000000000",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=aaaaaaaaaaa",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=30",
      "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com/watch",
      "https://www.youtube.com/playlist?list=PL0000000000",
      "https://www.youtube.com/@channel",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ?si=tracking",
      "https://youtu.be/dQw4w9WgXcQ/extra",
      "https://www.youtube-nocookie.com/watch?v=dQw4w9WgXcQ",
    ]) {
      expect(() => assertAcquirableUrl(url), url).toThrow(/not a single video/);
    }
  });

  it("refuses any other host, however it is dressed up", () => {
    // yt-dlp's generic extractor follows redirects anywhere — including to an
    // address only this machine can reach — so the host IS the boundary.
    for (const url of [
      "https://example.com/video.mp4",
      "https://youtube.com.evil.test/watch?v=x",
      "https://evil.test/youtube.com/watch?v=x",
      "https://notyoutube.com/watch?v=x",
      "https://127.0.0.1/watch?v=x",
      "https://localhost/watch?v=x",
      "https://www.youtube.com:8443/watch?v=x",
    ]) {
      expect(() => assertAcquirableUrl(url), url).toThrow(/not on a site we can fetch from/);
    }
  });
});

describe("failure classification", () => {
  it("does not retry a video that will be just as private next time", () => {
    for (const stderr of [
      "ERROR: [youtube] x: Private video. Sign in if you've been granted access",
      "ERROR: [youtube] x: Video unavailable",
      "ERROR: [youtube] x: Sign in to confirm your age",
    ]) {
      expect(classify(stderr, "we could not download that video").retryable, stderr).toBe(false);
    }
  });

  it("retries anything it does not recognise, rather than guessing permanent", () => {
    // Guessing "permanent" on a transient network fault loses the job outright.
    const error = classify("ERROR: unable to download: HTTP Error 503", "nope");
    expect(error.retryable).toBe(true);
  });

  it("redacts a signed URL out of the detail it keeps", () => {
    const error = classify(
      "ERROR: unable to open https://cdn.example.test/v.mp4?X-Amz-Signature=deadbeef&t=1",
      "nope",
    );
    expect(error.detail ?? "").not.toContain("deadbeef");
    expect(error.detail ?? "").toContain("redacted");
  });

  it("gives a user-facing message with nothing technical in it", () => {
    const error = classify("ERROR: [youtube] x: Private video", "we could not download that video");
    for (const word in { ffmpeg: 1, "yt-dlp": 1, stderr: 1, ERROR: 1 }) {
      expect(error.message.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it("names every refusal it can recognise, with the reason as the code", () => {
    const cases: [string, string][] = [
      ["ERROR: [youtube] x: Private video. Sign in if you've been granted access to this video", "media/source_private"],
      ["ERROR: [youtube] x: Join this channel to get access to members-only content like this video, and other exclusive perks.", "media/source_private"],
      ["ERROR: [youtube] x: This video is available to this channel's members on level: Tier 1", "media/source_private"],
      // The same line with the apostrophe lost to a code page.
      ["ERROR: [youtube] x: This video is available to this channel�s members on level: Tier 1", "media/source_private"],
      ["ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate for some users.", "media/source_age_restricted"],
      ["ERROR: [youtube] x: This live event will begin in 3 hours.", "media/source_live"],
      ["ERROR: [youtube] x: Premieres in 2 hours", "media/source_live"],
      ["ERROR: [youtube] x: Video unavailable", "media/source_removed"],
      ["ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader", "media/source_removed"],
      ["ERROR: [youtube] x: Video unavailable. This video is no longer available because the YouTube account associated with this video has been terminated.", "media/source_removed"],
      ["ERROR: [youtube] x: The uploader has not made this video available in your country", "media/source_removed"],
      ["ERROR: Unsupported URL: https://example.test/page", "media/unsupported"],
    ];
    for (const [output, reason] of cases) {
      const error = classify(output, "we could not download that video");
      expect(error, output).toMatchObject({ reason, code: reason, retryable: false });
    }
  });

  it("recognises the bot check, verbatim from production, as a block — not retried", () => {
    // Job 01M2NRC4T1DC2ZQ19SPYK4ZHST: retried at 5 s and 10 s into the same
    // block, then reported as a permanent "choose another video". The
    // apostrophe arrived mangled by the Windows code page, so the match cannot
    // depend on it.
    for (const output of [
      "ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you�re not a bot. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies.",
      "ERROR: [youtube] x: Sign in to confirm you’re not a bot.",
      "ERROR: [youtube] x: Sign in to confirm you're not a bot.",
    ]) {
      expect(classify(output, "nope"), output).toMatchObject({
        reason: "media/source_blocked",
        code: "media/source_blocked",
        retryable: false,
      });
    }
  });

  it("reads YouTube's rate limit as a block, although it begins 'Video unavailable'", () => {
    // yt-dlp's own wording for a session rate-limited "for up to an hour". It
    // must not read as a removed video: the same link works once it lifts.
    const error = classify(
      "ERROR: [youtube] x: Video unavailable. This content isn't available, try again later. The current session has been rate-limited by YouTube for up to an hour.",
      "nope",
    );
    expect(error.reason).toBe("media/source_blocked");
  });

  it("reads an HTTP 429 or a captcha as a block", () => {
    for (const output of [
      "ERROR: unable to download video data: HTTP Error 429: Too Many Requests",
      "ERROR: [youtube] x: Please solve the captcha",
    ]) {
      expect(classify(output, "nope").reason, output).toBe("media/source_blocked");
    }
  });

  it("finds the size abort on stdout, where yt-dlp prints it, with no ERROR line at all", () => {
    const error = classify(
      [
        "[youtube] Extracting URL: https://www.youtube.com/watch?v=x",
        "[info] x: Downloading 1 format(s): 401+140",
        "[download] File is larger than max-filesize (538391240 bytes > 524288000 bytes). Aborting.",
      ].join("\n"),
      "nope",
    );
    expect(error).toMatchObject({
      reason: "media/too_large",
      code: "media/too_large",
      retryable: false,
      // Both numbers are in yt-dlp's own line, and the page states them.
      facts: { approximateBytes: 538_391_240, maxBytes: 524_288_000 },
    });
  });

  it("reads a block YouTube said only in warnings, when the final error names nothing", () => {
    // Per-client bot checks and 429s arrive as warnings, then yt-dlp gives up
    // with a generic error. Retried, that went back to YouTube twice more
    // within fifteen seconds of being told to stop.
    for (const output of [
      [
        "WARNING: [youtube] x: Sign in to confirm you�re not a bot. Skipping client web",
        "ERROR: [youtube] x: Requested format is not available. Use --list-formats for a list of available formats",
      ],
      [
        "WARNING: [youtube] Unable to download API page: HTTP Error 429: Too Many Requests",
        "ERROR: unable to download video data: HTTP Error 403: Forbidden",
      ],
    ]) {
      const error = classify(output.join("\n"), "we could not download that video");
      expect(error, output[0]).toMatchObject({ reason: "media/source_blocked", retryable: false });
      // The operator sees the warning that decided it, not only the error.
      expect(error.detail, output[0]).toContain("WARNING:");
    }
  });

  it("never lets a warning make a failure private, removed or anything but a block", () => {
    // One client being told a video is private or unavailable is routine while
    // another succeeds; the download then failing on a 503 is a network fault.
    for (const warning of [
      "WARNING: [youtube] x: Private video. Skipping client android",
      "WARNING: [youtube] x: Video unavailable. Skipping client tv",
      "WARNING: [youtube] x: Some formats may be missing; try again later",
    ]) {
      const error = classify(
        [warning, "ERROR: unable to download video data: HTTP Error 503: Service Unavailable"].join(
          "\n",
        ),
        "we could not download that video",
      );
      expect(error, warning).toMatchObject({ retryable: true, reason: "media/source_failed" });
    }
  });

  it("lets an ERROR that names the refusal win over a block warning", () => {
    const error = classify(
      [
        "WARNING: [youtube] x: Sign in to confirm you're not a bot. Skipping client web",
        "ERROR: [youtube] x: Private video. Sign in if you've been granted access to this video",
      ].join("\n"),
      "nope",
    );
    expect(error.reason).toBe("media/source_private");
  });

  it("reads a 429 from ffmpeg's reader as a block, where yt-dlp's only ERROR names ffmpeg", () => {
    // A section download: yt-dlp hands the fetch to ffmpeg, which prints the
    // reason, and yt-dlp then says only that ffmpeg failed. Read as an unnamed
    // failure, the caller fetched the whole video from the refused address.
    const output = [
      "[info] x: Downloading 1 time ranges: 0.0-1200.0",
      "[download] Destination: source.mp4",
      "[https @ 000001d3c4a8f2c0] HTTP error 429 Too Many Requests",
      "[in#0 @ 000001d3c4a7e100] Error opening input: Server returned 4XX Client Error, but not one of 40{0,1,3,4}",
      "ERROR: ffmpeg exited with code 1",
    ].join("\n");
    expect(classify(output, "nope")).toMatchObject({
      reason: "media/source_blocked",
      code: "media/source_blocked",
      retryable: false,
    });
    expect(classify(output, "nope").detail).toContain("HTTP error 429");
  });

  it("leaves a 403 from ffmpeg's reader, or a 429 in a title, to be retried", () => {
    // An expired stream URL looks like this too, and the whole file may get it.
    for (const output of [
      "[https @ 000001d3c4a8f2c0] HTTP error 403 Forbidden\nERROR: ffmpeg exited with code 1",
      "[download] Destination: HTTP error 429 too many requests (live).mp4\nERROR: ffmpeg exited with code 1",
    ]) {
      expect(classify(output, "nope"), output).toMatchObject({
        retryable: true,
        code: "media/acquire_failed",
      });
    }
  });

  it("gives an unrecognised failure a retry, and a reason for when retries run out", () => {
    const error = classify("ERROR: unable to download: HTTP Error 503", "nope");
    expect(error).toMatchObject({
      code: "media/acquire_failed",
      retryable: true,
      reason: "media/source_failed",
    });
  });
});

describe("progress parsing", () => {
  it("reads a percentage out of a download line", () => {
    expect(parseProgress("[download]  42.3% of 100.00MiB at 1.00MiB/s")).toBe(42.3);
    expect(parseProgress("[download] 100% of 100.00MiB")).toBe(100);
  });

  it("returns null for anything else, so a format change costs progress not a job", () => {
    expect(parseProgress("[info] Writing video subtitles")).toBeNull();
    expect(parseProgress("")).toBeNull();
  });

  it("clamps a nonsense percentage rather than reporting it", () => {
    expect(parseProgress("[download] 900% of ?")).toBe(100);
  });
});

describe("the pin", () => {
  it("names the release ADR 0002 fixes", () => {
    expect(EXPECTED_VERSION).toBe("2026.08.19");
  });

  it("has no digest yet, and therefore refuses to verify one", () => {
    // This is the honest state: nobody has recorded the publisher's checksum, so
    // `assertYtDlpUsable({verifyDigest: true})` refuses to start. When the digest
    // IS recorded this test changes to assert its shape — it is here so that
    // "there is no digest" is a deliberate, visible fact rather than an omission.
    expect(EXPECTED_SHA256).toBeNull();
  });
});

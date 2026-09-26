import { describe, expect, it } from "vitest";

import { assertAcquirableUrl } from "./processors/acquire.js";
import {
  EXPECTED_SHA256,
  EXPECTED_VERSION,
  NEVER_ALLOWED_ARGS,
  assertNoForbiddenArgs,
  assertWithinLimits,
  buildArgs,
  buildProbeArgs,
  classify,
  parseProgress,
} from "./yt-dlp.js";

import type { AcquireLimits, SourceMetadata } from "./yt-dlp.js";

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
    ]) {
      const args = builder();
      for (const forbidden of NEVER_ALLOWED_ARGS) {
        expect(args, forbidden).not.toContain(forbidden);
      }
    }
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

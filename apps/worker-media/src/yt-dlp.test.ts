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

  it("does not refuse a source that simply did not say how big it is", () => {
    // Unknown is not "too big": the real size is measured after the download,
    // and refusing here would reject every source with sparse metadata.
    expect(() => {
      assertWithinLimits({ ...SAFE_METADATA, approximateBytes: null, durationMs: null }, LIMITS);
    }).not.toThrow();
  });
});

describe("the worker's own URL check", () => {
  it("accepts a normalised HTTPS URL", () => {
    expect(assertAcquirableUrl("https://www.youtube.com/watch?v=x").hostname).toBe(
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

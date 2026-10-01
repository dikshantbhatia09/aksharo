import { describe, expect, it } from "vitest";

import { acquirableSource, assertHostedUrl, windowForSite } from "./processors/acquire.js";
import {
  DownloaderUnusableError,
  HOSTED_EXTRACTORS,
  buildArgs,
  buildProbeArgs,
  chooseFormat,
  classify,
  extractorArgs,
} from "./yt-dlp.js";

import type { AcquireLimits, HostedExtractor, ProbeFormat } from "./yt-dlp.js";

/**
 * Vimeo, Google Drive and Dropbox links (2026-10-01): the worker's own check
 * of the address it is handed, and the argument lists that fetch it. The
 * addresses accepted are exactly the ones the API's `hostedUrlOf`
 * (`apps/api/src/repurpose/source-url.ts`) writes; nothing here touches a
 * network.
 */

const LIMITS: AcquireLimits = {
  maxBytes: 1_000_000_000,
  maxDurationMs: 1_200_000,
  timeoutMs: 600_000,
};

const DRIVE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";

describe("the worker's check of a hosted link", () => {
  it("accepts every address the API rebuilds from a fingerprint, with its site's extractor", () => {
    const cases: readonly (readonly [string, HostedExtractor])[] = [
      ["https://vimeo.com/76979871", "vimeo"],
      ["https://vimeo.com/76979871/0123456789", "vimeo"],
      [`https://drive.google.com/file/d/${DRIVE_ID}/view`, "googledrive"],
      ["https://www.dropbox.com/s/abc123xyz/talk.mp4", "dropbox"],
      ["https://www.dropbox.com/s/abc123xyz/My%20talk%20(final).mp4", "dropbox"],
      ["https://www.dropbox.com/scl/fi/a1b2c3d4e5/talk.mp4?rlkey=k1k2k3k4k5", "dropbox"],
    ];
    for (const [url, extractor] of cases) {
      expect(assertHostedUrl(url).extractor, url).toBe(extractor);
    }
  });

  it("refuses insecure links, credentials, ports and anything that is not an address", () => {
    expect(() => assertHostedUrl("http://vimeo.com/76979871")).toThrow(/secure connection/);
    expect(() => assertHostedUrl("https://user:pass@vimeo.com/76979871")).toThrow(
      /username or password/,
    );
    expect(() => assertHostedUrl("https://vimeo.com:8443/76979871")).toThrow(/not on a site/);
    expect(() => assertHostedUrl("not a url")).toThrow(/not a valid address/);
  });

  it("refuses lookalike hosts, other hosts and the spellings the API never writes", () => {
    for (const url of [
      "https://vimeo.com.evil.test/76979871",
      "https://evil.test/vimeo.com/76979871",
      "https://notvimeo.com/76979871",
      "https://drive.google.com.evil.test/file/d/x/view",
      "https://docs.google.com/file/d/x/view",
      "https://dropbox.com.evil.test/s/abc123xyz/talk.mp4",
      "https://dl.dropboxusercontent.com/s/abc123xyz/talk.mp4",
      "https://127.0.0.1/76979871",
      "https://localhost/76979871",
      // The API accepts these from a person and rewrites them; a payload
      // carrying them was not written by the API.
      "https://www.vimeo.com/76979871",
      "https://player.vimeo.com/video/76979871",
      "https://dropbox.com/s/abc123xyz/talk.mp4",
      // A YouTube link is a youtube_url's, never a hosted one's.
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ]) {
      expect(() => assertHostedUrl(url), url).toThrow(/not on a site we can fetch from/);
    }
  });

  it("refuses anything on an allowed host that is not exactly one file", () => {
    for (const url of [
      "https://vimeo.com/76979871?autoplay=1",
      "https://vimeo.com/76979871#t=30",
      "https://vimeo.com/channels/staffpicks",
      "https://vimeo.com/76979871/NOTAHASH",
      "https://vimeo.com/user12345",
      `https://drive.google.com/file/d/${DRIVE_ID}/view?usp=sharing`,
      `https://drive.google.com/open?id=${DRIVE_ID}`,
      "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz0",
      "https://drive.google.com/file/d/short/view",
      "https://www.dropbox.com/s/abc123xyz/talk.mp4?dl=0",
      "https://www.dropbox.com/scl/fi/a1b2c3d4e5/talk.mp4",
      "https://www.dropbox.com/scl/fi/a1b2c3d4e5/talk.mp4?rlkey=k1k2k3k4k5&dl=1",
      "https://www.dropbox.com/scl/fo/a1b2c3d4e5/folder?rlkey=k1k2k3k4k5",
      "https://www.dropbox.com/sh/abc123xyz/AAA",
      "https://www.dropbox.com/s/abc123xyz/a/b.mp4",
    ]) {
      expect(() => assertHostedUrl(url), url).toThrow(/not a single video/);
    }
  });

  it("keeps each kind on its own hosts", () => {
    expect(() => acquirableSource("youtube_url", "https://vimeo.com/76979871")).toThrow(
      /not on a site we can fetch from/,
    );
    expect(() =>
      acquirableSource("hosted_url", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).toThrow(/not on a site we can fetch from/);
    expect(
      acquirableSource("youtube_url", "https://www.youtube.com/watch?v=dQw4w9WgXcQ").extractor,
    ).toBeNull();
    expect(acquirableSource("hosted_url", "https://vimeo.com/76979871").extractor).toBe("vimeo");
  });
});

describe("the window on another site", () => {
  it("is the start where YouTube's most-replayed part would have been asked for", () => {
    const window = { maxMs: 1_200_000, policy: "most_replayed" as const };
    expect(windowForSite(window, "vimeo")).toEqual({ maxMs: 1_200_000, policy: "first" });
    expect(windowForSite(window, null)).toBe(window);
    const picked = { maxMs: 1_200_000, startMs: 60_000, policy: "range" as const };
    expect(windowForSite(picked, "dropbox")).toBe(picked);
    expect(windowForSite(undefined, "googledrive")).toBeUndefined();
  });
});

describe("the argument lists for a hosted link", () => {
  const argsFor = (extractor: HostedExtractor): readonly string[][] => [
    buildArgs({ url: "https://vimeo.com/1", outputPath: "/tmp/o.mp4", limits: LIMITS, extractor }),
    buildProbeArgs("https://vimeo.com/1", { extractor }),
  ];

  it("hold yt-dlp to the site's own extractor, before the URL", () => {
    for (const extractor of HOSTED_EXTRACTORS) {
      for (const args of argsFor(extractor)) {
        const at = args.indexOf("--use-extractors");
        expect(at, extractor).toBeGreaterThan(-1);
        expect(args[at + 1]).toBe(extractor);
        expect(at).toBeLessThan(args.indexOf("--"));
        // The lock-down every list carries is still there.
        expect(args).toContain("--ignore-config");
        expect(args).toContain("--no-playlist");
      }
    }
  });

  it("leave a YouTube list exactly as it was: no extractor named", () => {
    expect(
      buildArgs({ url: "https://youtu.be/x", outputPath: "/tmp/o.mp4", limits: LIMITS }),
    ).not.toContain("--use-extractors");
    expect(buildProbeArgs("https://youtu.be/x")).not.toContain("--use-extractors");
  });

  it("refuse an extractor that is not on the list, the generic one above all", () => {
    for (const name of ["generic", "all", "default", "vimeo,generic", "youtube"]) {
      expect(() => extractorArgs(name as HostedExtractor), name).toThrow(DownloaderUnusableError);
    }
  });
});

describe("format ids from another site", () => {
  it("chooses Vimeo's longer ids, and never one the argument list would refuse", () => {
    const formats: ProbeFormat[] = [
      {
        format_id: "hls-fastly_skyfire-1080p",
        vcodec: "avc1.640028",
        acodec: "mp4a.40.2",
        width: 1920,
        height: 1080,
        filesize: 100_000_000,
      },
      {
        format_id: "bad id; --exec x",
        vcodec: "avc1.640028",
        acodec: "mp4a.40.2",
        width: 3840,
        height: 2160,
        filesize: 10_000_000,
      },
    ] as ProbeFormat[];
    const choice = chooseFormat(formats, LIMITS, 600);
    expect(choice?.selector).toBe("hls-fastly_skyfire-1080p");
    expect(() =>
      buildArgs({
        url: "https://vimeo.com/1",
        outputPath: "/tmp/o.mp4",
        limits: LIMITS,
        format: choice?.selector ?? null,
        extractor: "vimeo",
      }),
    ).not.toThrow();
  });
});

describe("refusals from another site", () => {
  it("reads a password or a file shared with named people as private, not retried", () => {
    for (const output of [
      "ERROR: [vimeo] 76979871: This video is protected by a password, use the --video-password option",
      "ERROR: [GoogleDrive] 1AbC: You need access to this file",
      "ERROR: [Dropbox] abc: Password protected video, use --video-password <password>",
    ]) {
      expect(classify(output, "x"), output).toMatchObject({
        reason: "media/source_private",
        retryable: false,
      });
    }
  });

  it("reads a link its extractor does not claim as unsupported, not retried", () => {
    expect(classify("ERROR: Unsupported URL: https://vimeo.com/1", "x")).toMatchObject({
      reason: "media/unsupported",
      retryable: false,
    });
  });
});

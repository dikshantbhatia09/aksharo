import { describe, expect, it } from "vitest";

import {
  SOURCE_REJECTION_MESSAGES,
  parseSourceUrl,
  type SourceRejectionCode,
} from "./source-url.js";

/** The parse result, or a thrown assertion — keeps every case one line. */
function parse(url: string) {
  return parseSourceUrl(url);
}

function accepted(url: string) {
  const result = parse(url);
  if (!result.ok) throw new Error(`expected ${url} to be accepted, got ${result.code}`);
  return result.source;
}

function rejectedWith(url: string): SourceRejectionCode {
  const result = parse(url);
  if (result.ok) throw new Error(`expected ${url} to be rejected`);
  return result.code;
}

describe("YouTube forms", () => {
  it("accepts every documented single-video form", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ]) {
      expect(accepted(url).kind, url).toBe("youtube_url");
    }
  });

  it("gives long and short forms of one video the same identity", () => {
    // This is what makes ten pastes of the same video one download (§9.5).
    const forms = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=90s&feature=share",
      "https://youtu.be/dQw4w9WgXcQ?si=trackingparam",
    ];
    const fingerprints = new Set(forms.map((url) => accepted(url).sourceFingerprint));
    expect([...fingerprints]).toEqual(["youtube:dQw4w9WgXcQ"]);
  });

  it("canonicalises away tracking and timing parameters", () => {
    const source = accepted("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=90s&si=abc&list=PL123");
    expect(source.normalizedUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(source.display).toBe("youtube.com · dQw4w9WgXcQ");
  });

  it("imports one explicit video out of a playlist URL, and refuses the playlist", () => {
    // `watch?v=…&list=…` names a video; `/playlist?list=…` names only a list.
    expect(accepted("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123").sourceFingerprint).toBe(
      "youtube:dQw4w9WgXcQ",
    );
    expect(rejectedWith("https://www.youtube.com/playlist?list=PL123")).toBe(
      "playlist_not_supported",
    );
    expect(rejectedWith("https://www.youtube.com/watch?list=PL123")).toBe("playlist_not_supported");
  });

  it("refuses a YouTube page that is not a video", () => {
    for (const url of [
      "https://www.youtube.com/",
      "https://www.youtube.com/@somechannel",
      "https://www.youtube.com/results?search_query=hindi+podcast",
      "https://www.youtube.com/feed/subscriptions",
    ]) {
      expect(rejectedWith(url), url).toBe("missing_video_id");
    }
  });

  it("refuses a malformed video id rather than trying it", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com/watch?v=waytoolongforanid",
      "https://www.youtube.com/watch?v=has spaces!",
      "https://youtu.be/",
      "https://www.youtube.com/shorts/",
    ]) {
      expect(rejectedWith(url), url).toBe("missing_video_id");
    }
  });
});

describe("direct media links", () => {
  it("accepts a direct media file and keeps its signed query string", () => {
    const source = accepted("https://cdn.example.test/videos/ep12.mp4?sig=abc123");
    expect(source.kind).toBe("direct_media_url");
    expect(source.normalizedUrl).toBe("https://cdn.example.test/videos/ep12.mp4?sig=abc123");
  });

  it("keeps the signature out of the fingerprint and the display form", () => {
    // A signature expires; an identity must not. And a display string ends up in
    // a UI and in support tooling, where a token has no business being.
    const source = accepted("https://cdn.example.test/videos/ep12.mp4?sig=abc123&token=secret");
    expect(source.sourceFingerprint).toBe("url:https://cdn.example.test/videos/ep12.mp4");
    expect(source.display).toBe("cdn.example.test/videos/ep12.mp4");
    for (const field of [source.sourceFingerprint, source.display]) {
      expect(field).not.toContain("secret");
      expect(field).not.toContain("sig=");
    }
  });

  it("refuses an ordinary web page instead of fetching it", () => {
    // Widening this to HTML is exactly what §9.1 forbids: the safe fetcher is a
    // media fetcher, not a web client.
    for (const url of [
      "https://example.test/article",
      "https://example.test/video.html",
      "https://vimeo.com/123456",
      "https://www.instagram.com/reel/abc/",
    ]) {
      expect(rejectedWith(url), url).toBe("unsupported_source");
    }
  });
});

describe("hostile input", () => {
  it("refuses anything that is not HTTPS", () => {
    for (const url of [
      "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "ftp://example.test/v.mp4",
      "file:///etc/passwd",
      "data:video/mp4;base64,AAAA",
      "javascript:alert(1)",
    ]) {
      const code = rejectedWith(url);
      expect(["not_https", "not_a_url"], url).toContain(code);
    }
  });

  it("refuses credentials embedded in the URL", () => {
    expect(rejectedWith("https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "credentials_in_url",
    );
    expect(rejectedWith("https://user@cdn.example.test/v.mp4")).toBe("credentials_in_url");
  });

  it("is not fooled by a host that merely contains a known one", () => {
    // `youtube.com.evil.test` is `evil.test`, and `notyoutube.com` is not us.
    for (const url of [
      "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
      "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be.evil.test/dQw4w9WgXcQ",
      "https://evil.test/?q=https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ]) {
      expect(rejectedWith(url), url).toBe("unsupported_source");
    }
  });

  it("refuses shell and path metacharacters instead of normalising them", () => {
    // Nothing from here is ever a process argument (§9.2), but the parser must
    // not hand a caller something that looks like a clean id when it is not.
    for (const url of [
      "https://www.youtube.com/watch?v=abc;rm -rf /",
      "https://www.youtube.com/watch?v=$(whoami)abc",
      "https://www.youtube.com/watch?v=../../../etc",
      "https://www.youtube.com/watch?v=`id`abcdefg",
      "https://cdn.example.test/../../secret.mp4",
    ]) {
      const result = parse(url);
      if (result.ok) {
        // A direct-media URL may legitimately survive path traversal because the
        // URL parser resolves it; what matters is that nothing escaped the host.
        expect(new URL(result.source.normalizedUrl).hostname, url).toBe("cdn.example.test");
        expect(result.source.normalizedUrl, url).not.toContain("..");
      } else {
        expect(["missing_video_id", "unsupported_source"], url).toContain(result.code);
      }
    }
  });

  it("refuses empty, oversized and non-URL input", () => {
    expect(rejectedWith("")).toBe("not_a_url");
    expect(rejectedWith("   ")).toBe("not_a_url");
    expect(rejectedWith("dQw4w9WgXcQ")).toBe("not_a_url");
    expect(rejectedWith(`https://example.test/${"a".repeat(2_100)}.mp4`)).toBe("not_a_url");
  });

  it("never returns a normalised URL that is not HTTPS", () => {
    const candidates = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://cdn.example.test/a.mp4",
    ];
    for (const url of candidates) {
      expect(accepted(url).normalizedUrl.startsWith("https://"), url).toBe(true);
    }
  });
});

describe("rejection messages", () => {
  it("has plain language for every code, with nothing technical in it", () => {
    for (const [code, message] of Object.entries(SOURCE_REJECTION_MESSAGES)) {
      expect(message.length, code).toBeGreaterThan(10);
      for (const word of ["parse", "regex", "null", "undefined", "worker", "queue"]) {
        expect(message.toLowerCase(), code).not.toContain(word);
      }
    }
  });
});

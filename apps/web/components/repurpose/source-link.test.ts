import { describe, expect, it } from "vitest";

import { isPlausibleLink, normaliseSourceLink } from "./source-link";

describe("normaliseSourceLink", () => {
  it("adds https to a link pasted without a scheme", () => {
    expect(normaliseSourceLink("youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "https://youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(normaliseSourceLink("  youtu.be/dQw4w9WgXcQ ")).toBe("https://youtu.be/dQw4w9WgXcQ");
    expect(normaliseSourceLink("www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    );
  });

  it("upgrades http, and a shouted scheme, to https", () => {
    expect(normaliseSourceLink("http://www.youtube.com/watch?v=x")).toBe(
      "https://www.youtube.com/watch?v=x",
    );
    expect(normaliseSourceLink("HTTPS://youtu.be/x")).toBe("https://youtu.be/x");
  });

  it("finds the link in a share sheet's text", () => {
    expect(normaliseSourceLink("Watch this https://youtu.be/dQw4w9WgXcQ?si=abc")).toBe(
      "https://youtu.be/dQw4w9WgXcQ?si=abc",
    );
    expect(normaliseSourceLink("Great talk (youtu.be/dQw4w9WgXcQ).")).toBe(
      "https://youtu.be/dQw4w9WgXcQ",
    );
  });

  it("keeps a port, and does not mistake a time or an address for a link", () => {
    expect(normaliseSourceLink("example.com:8443/v.mp4")).toBe("https://example.com:8443/v.mp4");
    expect(normaliseSourceLink("at 1:05 youtu.be/x")).toBe("https://youtu.be/x");
    expect(normaliseSourceLink("me@example.com")).toBe("me@example.com");
  });

  it("answers at once for a long paste with no link in it", () => {
    const started = performance.now();
    normaliseSourceLink(`${"a.".repeat(20_000)}!`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("leaves what is not a link for the validator to refuse", () => {
    expect(normaliseSourceLink("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(normaliseSourceLink("ftp://example.com/a.mp4")).toBe("ftp://example.com/a.mp4");
    expect(normaliseSourceLink("   ")).toBe("");
  });
});

describe("isPlausibleLink", () => {
  it("wants an https address with a real host", () => {
    expect(isPlausibleLink("https://youtu.be/x")).toBe(true);
    expect(isPlausibleLink("ftp://example.com/a.mp4")).toBe(false);
    expect(isPlausibleLink("dQw4w9WgXcQ")).toBe(false);
    expect(isPlausibleLink("https://localhost/x")).toBe(false);
  });
});

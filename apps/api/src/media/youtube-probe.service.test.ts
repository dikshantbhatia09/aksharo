import { describe, expect, it, vi } from "vitest";
import { YouTubeProbeService, YOUTUBE_URL_REGEX } from "./youtube-probe.service.js";

describe("YouTubeProbeService URL pattern", () => {
  it("matches standard watch URLs", () => {
    expect(YOUTUBE_URL_REGEX.test("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    expect(YOUTUBE_URL_REGEX.test("http://youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
  });

  it("matches short URLs (youtu.be)", () => {
    expect(YOUTUBE_URL_REGEX.test("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
  });

  it("matches shorts URLs", () => {
    expect(YOUTUBE_URL_REGEX.test("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(true);
  });

  it("rejects non-YouTube or invalid URLs", () => {
    expect(YOUTUBE_URL_REGEX.test("https://vimeo.com/12345678")).toBe(false);
    expect(YOUTUBE_URL_REGEX.test("https://example.com/video")).toBe(false);
  });
});

describe("YouTubeProbeService probe execution", () => {
  it("throws badRequest for invalid URLs", async () => {
    const service = new YouTubeProbeService();
    await expect(service.probe("https://vimeo.com/123456")).rejects.toThrow();
  });
});


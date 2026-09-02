import { describe, expect, it } from "vitest";

import {
  MINIMUM_FFMPEG_MAJOR,
  MediaToolsMissingError,
  MediaToolsTooOldError,
  REQUIRED_TOOLS,
  assertMediaToolsAvailable,
  parseMajor,
  toolVersion,
} from "./media-tools.js";

describe("parseMajor", () => {
  it("reads the major out of the builds this worker actually meets", () => {
    expect(parseMajor("ffmpeg version 9.0-full_build-www.gyan.dev Copyright (c) 2000-2026")).toBe(
      9,
    );
    expect(parseMajor("ffprobe version 6.1.1-3ubuntu5 Copyright (c) 2007-2023")).toBe(6);
    // Debian's own builds prefix the number with `n`.
    expect(parseMajor("ffmpeg version n7.1 Copyright (c) 2000-2024")).toBe(7);
  });

  it("answers null for a banner with no version in it", () => {
    expect(parseMajor("ffmpeg version SOMEVENDOR-custom")).toBeNull();
    expect(parseMajor("")).toBeNull();
  });
});

describe("assertMediaToolsAvailable", () => {
  it("names both binaries as required", () => {
    expect([...REQUIRED_TOOLS]).toEqual(["ffmpeg", "ffprobe"]);
  });

  it("refuses to start when a binary is missing, with instructions", async () => {
    await expect(
      assertMediaToolsAvailable({
        ffmpeg: "montaj-no-such-ffmpeg",
        ffprobe: "montaj-no-such-ffprobe",
      }),
    ).rejects.toBeInstanceOf(MediaToolsMissingError);

    const error = await assertMediaToolsAvailable({
      ffmpeg: "montaj-no-such-ffmpeg",
      ffprobe: "montaj-no-such-ffprobe",
    }).catch((caught: unknown) => caught as MediaToolsMissingError);
    expect(error.missing).toEqual(["ffmpeg", "ffprobe"]);
    expect(error.message).toContain("winget install Gyan.FFmpeg");
  });

  it("accepts the ffmpeg on this machine, and it is new enough", async () => {
    const version = await toolVersion("ffmpeg");
    if (version === null) {
      // A machine with no ffmpeg still runs the rest of the suite; the missing
      // case above is the one that has to hold everywhere.
      expect(version).toBeNull();
      return;
    }
    const tools = await assertMediaToolsAvailable();
    expect(tools.map((tool) => tool.tool)).toEqual(["ffmpeg", "ffprobe"]);
    for (const tool of tools) {
      expect(tool.version, tool.tool).toContain("version");
      if (tool.major !== null) expect(tool.major).toBeGreaterThanOrEqual(MINIMUM_FFMPEG_MAJOR);
    }
  });
});

describe("MediaToolsTooOldError", () => {
  it("says which build it found and why the floor exists", () => {
    const error = new MediaToolsTooOldError([
      { tool: "ffmpeg", version: "ffmpeg version 4.4.2", major: 4 },
      { tool: "ffprobe", version: "ffprobe version 4.4.2", major: 4 },
    ]);
    expect(error.message).toContain("ffmpeg version 4.4.2");
    expect(error.message).toContain("zscale");
    expect(error.message).toContain(String(MINIMUM_FFMPEG_MAJOR));
  });
});
